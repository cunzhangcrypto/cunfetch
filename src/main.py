"""CunFetch 一次性执行入口。

运行方式：
  python -m src.main            # 默认：执行所有 pending 任务
  python -m src.main --run      # 同上，显式
  python -m src.main --detect   # GitHub Actions 侧：检测新文章并写入 Google Sheets

程序执行完即退出，不常驻、不轮询（需求第五/三十一节）。
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from .config.settings import Settings, load_settings
from .interfaces.task_provider import Task

logger = logging.getLogger("cunfetch")


def _setup_logging(settings: Settings) -> Path:
    level = getattr(logging, (settings.logging.level or "INFO").upper(), logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    # 同时写入日志文件 logs/YYYY-MM-DD.log（需求第三十节）
    log_dir = Path(settings.storage.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    log_file = log_dir / f"{today}.log"
    fh = logging.FileHandler(str(log_file), encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    logging.getLogger().addHandler(fh)
    return log_file


def _build_provider(settings: Settings):
    from .sheets.client import GoogleSheetsProvider

    return GoogleSheetsProvider(settings)


def cmd_run(settings: Settings) -> int:
    logger.info("===== CunFetch 启动 (run) =====")
    try:
        provider = _build_provider(settings)
    except Exception as exc:  # noqa: BLE001
        logger.error("连接任务队列失败: %s", exc)
        print(f"[错误] {exc}")
        return 1
    manager = None  # 延迟导入避免无数据时仍加载
    try:
        pending = provider.get_pending_tasks()
        logger.info("发现 pending 任务 %s 个", len(pending))
        if not pending:
            logger.info("没有待处理任务，退出")
            return 0

        from .tasks.manager import TaskManager

        manager = TaskManager(settings, provider)
        ok = failed = 0
        for task in pending:
            logger.info("处理任务 %s", task.url)
            result = manager.process_task(task)
            if result.status == "completed":
                ok += 1
            else:
                failed += 1
        logger.info("任务处理完成 → 成功 %s，失败 %s", ok, failed)
        return 0 if failed == 0 else 1
    finally:
        try:
            provider.close()
        except Exception:  # noqa: BLE001
            pass
        logger.info("===== CunFetch 退出 =====")


def cmd_detect(settings: Settings) -> int:
    """GitHub Actions 用于：检测博客新文章并写入 Google Sheets 任务队列。"""
    logger.info("===== CunFetch detect 启动 =====")
    from .blog.detector import detect_new_articles

    try:
        provider = _build_provider(settings)
    except Exception as exc:  # noqa: BLE001
        logger.error("连接任务队列失败: %s", exc)
        print(f"[错误] {exc}")
        return 1
    try:
        articles = detect_new_articles(settings)
        logger.info("检测到候选文章 %s 篇", len(articles))
        created = 0
        for art in articles:
            task = Task.new(url=art.url, title=art.title, published_at=art.published_at)
            if provider.create(task):
                created += 1
                logger.info("新建任务: %s | %s", art.title, art.url)
            else:
                logger.info("URL 已存在，跳过: %s", art.url)
        logger.info("本次新建任务 %s 个", created)
        return 0
    finally:
        try:
            provider.close()
        except Exception:  # noqa: BLE001
            pass
        logger.info("===== CunFetch detect 退出 =====")


def _resolve_local_dir(target: str, settings: Settings) -> Path:
    """把 --video 目标解析为文章本地目录：
    优先级：本地目录路径 → storage.root 下按目录名匹配 → 按 info.json 的 url/title 匹配。"""
    t = (target or "").strip()
    if not t:
        raise ValueError("请用 --video 指定目标：本地目录路径 / 文章URL / 标题关键词")
    p = Path(t)
    if p.is_dir():
        return p.resolve()
    root = Path(settings.storage.root)
    if not root.is_dir():
        raise ValueError(f"素材根目录不存在: {root}")
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        if t.lower() in d.name.lower():
            return d.resolve()
        ip = d / "info.json"
        if ip.is_file():
            try:
                info = json.loads(ip.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                info = {}
            if (info.get("url") or "").lower() == t.lower() or \
               t.lower() in (info.get("title") or "").lower() or \
               t.lower() in (info.get("url") or "").lower():
                return d.resolve()
    raise ValueError(f"在 {root} 下找不到匹配目标: {t}")


def cmd_video_pending(settings: Settings) -> int:
    """渲染所有"已采集但尚无视频"的文章目录，逐个生成 10s 视频并回填表格状态。

    待做判定：本地目录存在 article.md（已采集）且 video/ 子目录缺少 *.mp4。
    已渲染过的（NextChat/DNS 等）自动跳过 → 天然增量，只处理"新增待做"。
    单篇失败不中断整批。
    """
    logger.info("===== CunFetch video-pending 启动 =====")
    try:
        from .video.video_core import render_one  # 惰性导入：私有模块，公开仓库缺失也能跑其余子命令
    except Exception as exc:  # noqa: BLE001
        logger.error("视频模块不可用（私有 src/video 缺失或依赖未装）: %s", exc)
        print(f"[错误] 视频模块不可用: {exc}")
        return 2

    root = Path(settings.storage.root)
    if not root.is_dir():
        print(f"[错误] 素材根目录不存在: {root}")
        return 1

    targets = []
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        if not (d / "article.md").is_file():
            continue  # 未完成采集，跳过
        video_dir = d / "video"
        if video_dir.is_dir() and any(video_dir.glob("*.mp4")):
            continue  # 已有视频，跳过
        targets.append(d)

    logger.info("待渲染文章 %s 篇", len(targets))
    if not targets:
        print("[无待做视频] 已采集文章中，本地没有任何缺视频的待渲染项")
        return 0

    ok = failed = 0
    for d in targets:
        logger.info("渲染视频: %s", d.name)
        print(f"[视频] 开始渲染: {d.name}")
        try:
            meta = render_one(d, settings, progress_callback=None)
            _mark_video_done(settings, meta)
            ok += 1
            print(f"[视频完成] {ok}/{len(targets)}: {meta['video']}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            logger.error("视频失败(继续下一篇): %s | %s", d.name, exc)
            print(f"[视频失败] {d.name}: {exc}")
    print(f"[批处理结束] 成功 {ok}，失败 {failed}")
    return 0 if failed == 0 else 1


def cmd_video(settings: Settings, target: str) -> int:
    """渲染指定文章本地目录的 10s 短视频 + 三平台标题/标签 JSON。"""
    logger.info("===== CunFetch video 启动 =====")
    try:
        from .video.video_core import render_one  # 惰性导入：私有模块，公开仓库缺失也能跑其余子命令
    except Exception as exc:  # noqa: BLE001
        logger.error("视频模块不可用（私有 src/video 缺失或依赖未装）: %s", exc)
        print(f"[错误] 视频模块不可用: {exc}")
        return 2
    try:
        local_dir = _resolve_local_dir(target, settings)
        meta = render_one(local_dir, settings)
        print(f"[视频完成] {meta['video']}")
        print("[三平台标题/标签 JSON 已写入]")
        print(json.dumps(meta.get("platforms", {}), ensure_ascii=False, indent=2))
        _mark_video_done(settings, meta)
        return 0
    except Exception as exc:  # noqa: BLE001
        logger.error("视频生成失败: %s", exc)
        print(f"[错误] {exc}")
        return 1


def _mark_video_done(settings: Settings, meta: dict) -> None:
    """视频渲染成功后，把任务表对应行（按文章 URL）的 video_status 回写为 completed。

    回写失败只告警，不影响视频产物本身。
    """
    url = (meta.get("article_url") or "").strip()
    if not url:
        logger.warning("视频无对应 URL，跳过表格回写")
        return
    try:
        from .interfaces.task_provider import VIDEO_COMPLETED
        from .sheets.client import GoogleSheetsProvider

        provider = GoogleSheetsProvider(settings)
        try:
            ok = provider.mark_video_status(url, VIDEO_COMPLETED)
            if ok:
                logger.info("表格回写成功: video_status=completed | %s", url)
                print(f"[表格] 已将视频状态回写为完成: {url}")
            else:
                logger.warning("表格中未找到该 URL 的任务，跳过回写: %s", url)
                print(f"[表格] 未在任务表找到该 URL，跳过回写: {url}")
        finally:
            provider.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("视频完成状态回写失败(不影响视频): %s", exc)
        print(f"[警告] 视频状态回写失败(不影响视频): {exc}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="CunFetch", description="一次执行型内容采集与素材归档工具")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--run", action="store_true", help="执行所有 pending 任务（默认）")
    group.add_argument("--detect", action="store_true", help="检测博客新文章并写入任务队列")
    group.add_argument("--video", nargs="?", const="", metavar="TARGET",
                       help="为指定文章本地目录/URL/标题关键词 渲染 10s 短视频+三平台标题标签")
    group.add_argument("--video-pending", action="store_true",
                       help="渲染所有已采集但本地尚无视频(缺 video/*.mp4)的文章，逐个生成并回填状态")
    parser.add_argument("--config", default=None, help="配置文件路径（默认 config.yaml）")
    args = parser.parse_args(argv)

    settings = load_settings(args.config)
    if settings.source is None:
        print("[警告] 未找到 config.yaml，使用内置默认配置（可能无法连接 Google Sheets）。")

    log_file = _setup_logging(settings)
    logger.info("使用配置: %s", settings.source)

    if args.video is not None:
        return cmd_video(settings, args.video)
    if args.video_pending:
        return cmd_video_pending(settings)
    if args.detect:
        return cmd_detect(settings)
    return cmd_run(settings)


if __name__ == "__main__":
    raise SystemExit(main())