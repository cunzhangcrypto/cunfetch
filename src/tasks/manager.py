"""单篇文章采集流程编排。

流程（需求第十五节）：
  获取 URL → 下载网页 → 解析 → 提取标题/时间/正文 → 提取图片 →
  过滤无效 → 统计 → 不足 5 张则网络补充 → 下载 → 本地归档 → 更新状态。

关键约束：
  - 单张图片失败不导致整篇文章失败（原则 10）
  - 图片来源必须记录（原则 11）
  - 幂等：completed 不重复下载（原则 8）
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from pathlib import Path

from ..blog import image_extractor, parser as article_parser
from ..images import downloader, searcher
from ..images.downloader import pick_extension
from ..images.validator import is_valid_url
from ..interfaces import task_provider as tp
from ..interfaces.task_provider import COMPLETED, FAILED, PROCESSING
from ..storage.local import LocalStorage

logger = logging.getLogger(__name__)


class TaskError(RuntimeError):
    pass


class TaskManager:
    """负责把一条 Task 从 pending 跑成 completed/failed。"""

    def __init__(self, settings, provider: tp.TaskProvider, storage: LocalStorage | None = None):
        self.settings = settings
        self.provider = provider
        self.storage = storage or LocalStorage(str(settings.storage.root))
        self.target_images = int(settings.images.target_count)

    # ---------- 对外主入口 ----------
    def process_task(self, task: tp.Task) -> tp.Task:
        """执行单条任务，返回带结果的新 Task。"""
        task.status = PROCESSING
        task.error = ""
        self._save(task)
        logger.info("开始处理文章: %s (%s)", task.url, task.title or "")

        try:
            parsed = article_parser.parse_article(task.url, self.settings)
            if not parsed.title or not parsed.markdown:
                raise TaskError("未能解析出文章标题或正文")

            task.title = parsed.title or task.title
            task.published_at = parsed.published_at or task.published_at

            # 建目录，图片先以临时名下载，最后统一重命名编号
            article_dir = self.storage.create_article_dir(task)
            images_dir = self.storage.images_dir(article_dir)
            kept: list[dict] = []

            # 1) 博客图片（提取 -> 过滤 -> 下载）
            kept = self._collect_blog_images(parsed, images_dir, kept, limit=self.target_images)

            # 2) 网络补充
            need = self.target_images - len(kept)
            if need > 0:
                kept = self._collect_web_images(parsed, images_dir, kept, need=need)

            if len(kept) == 0:
                raise TaskError("未获取到任何有效图片")

            # 统一编号重命名 01..N，并生成正式来源记录
            final = self._finalize(images_dir, kept)

            # 3) 落盘归档
            self.storage.save_article_md(article_dir, parsed.markdown, task.title, task.url, task.published_at)
            info = self._build_info(task, parsed, final)
            self.storage.save_info_json(article_dir, info)
            self.storage.save_source_txt(article_dir, task.url, final)

            # 4) 回填结果并置 completed
            blog_n = sum(1 for s in final if s["type"] == "Blog")
            web_n = len(final) - blog_n
            task.blog_images = blog_n
            task.web_images = web_n
            task.total_images = len(final)
            task.local_path = str(article_dir)
            task.status = COMPLETED
            task.error = ""
            logger.info("文章完成: %s 本地: %s 图片数: %s", task.title, article_dir, len(final))
            self._save(task)
            return task

        except Exception as exc:  # noqa: BLE001
            logger.exception("文章处理失败: %s", task.url)
            if isinstance(exc, TaskError):
                reason = str(exc)
            else:
                reason = f"{type(exc).__name__}: {exc}"
            task.status = FAILED
            task.error = reason[:500]
            try:
                self._save(task)
            except Exception:  # noqa: BLE001
                logger.exception("更新失败状态时出错")
            return task

    # ---------- 内部方法 ----------
    def _save(self, task) -> None:
        task.updated_at = datetime.now().astimezone().isoformat(timespec="seconds")
        self.provider.update(task)

    def _collect_blog_images(self, parsed, images_dir: Path, kept: list[dict], limit: int) -> list[dict]:
        candidates = image_extractor.extract_image_urls(parsed.soup, parsed.url)
        seen: set[str] = {s["url"] for s in kept}
        valid_urls: list[str] = []
        for u in candidates:
            if is_valid_url(u, self.settings) and u not in seen:
                seen.add(u)
                valid_urls.append(u)
        logger.info("博客图片候选 %s，URL 过滤后 %s", len(candidates), len(valid_urls))

        for url in valid_urls[: limit * 3]:
            if len(kept) >= limit:
                break
            entry = self._download_to_temp(url, images_dir, "Blog")
            if entry:
                kept.append(entry)
        return kept

    def _collect_web_images(self, parsed, images_dir: Path, kept: list[dict], need: int) -> list[dict]:
        keywords = searcher.build_search_keywords(parsed.title, parsed.markdown)
        logger.info("网络图片搜索关键词: %s", keywords)
        urls = searcher.search_images(keywords, self.settings, need * 3)
        seen: set[str] = {s["url"] for s in kept}
        start = len(kept)
        for url in urls:
            if len(kept) >= need:
                break
            if not is_valid_url(url, self.settings) or url in seen:
                continue
            entry = self._download_to_temp(url, images_dir, "Web")
            if entry:
                seen.add(url)
                kept.append(entry)
        logger.info("网络补充图片获得 %s/需 %s", len(kept) - start, need)
        return kept

    def _download_to_temp(self, url: str, images_dir: Path, source_type: str) -> dict | None:
        """下载到临时文件名；成功返回 {'temp_path','url','type'}，失败返回 None。"""
        ext = pick_extension(url, self.settings)
        if not ext:
            logger.info("跳过无法判断格式的图片: %s", url)
            return None
        temp = images_dir / f"_tmp_{uuid.uuid4().hex}.{ext}"
        ok = downloader.download_image(url, str(temp), self.settings)
        if not ok:
            temp.unlink(missing_ok=True)
            return None
        return {"temp_path": temp, "url": url, "type": source_type}

    def _finalize(self, images_dir: Path, kept: list[dict]) -> list[dict]:
        """把临时图片重命名为 01..N 序号，返回正式来源记录。"""
        final: list[dict] = []
        for i, entry in enumerate(kept, start=1):
            temp = Path(entry["temp_path"])
            ext = temp.suffix or ".jpg"
            filename = f"{i:02d}{ext}"
            dest = images_dir / filename
            try:
                temp.rename(dest)
            except OSError:
                temp.replace(dest)
            final.append({"filename": filename, "type": entry["type"], "url": entry["url"]})
        return final

    def _build_info(self, task, parsed, sources: list[dict]) -> dict:
        blog_n = sum(1 for s in sources if s["type"] == "Blog")
        web_n = len(sources) - blog_n
        return {
            "task_id": task.task_id,
            "title": task.title,
            "url": task.url,
            "published_at": task.published_at,
            "blog_image_count": blog_n,
            "web_image_count": web_n,
            "total_image_count": len(sources),
            "status": COMPLETED,
            "created_at": task.created_at,
            "completed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }