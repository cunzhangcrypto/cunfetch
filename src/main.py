"""CunFetch 一次性执行入口。

运行方式：
  python -m src.main            # 默认：执行所有 pending 任务
  python -m src.main --run      # 同上，显式
  python -m src.main --detect   # GitHub Actions 侧：检测新文章并写入 Google Sheets

程序执行完即退出，不常驻、不轮询（需求第五/三十一节）。
"""
from __future__ import annotations

import argparse
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="CunFetch", description="一次执行型内容采集与素材归档工具")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--run", action="store_true", help="执行所有 pending 任务（默认）")
    group.add_argument("--detect", action="store_true", help="检测博客新文章并写入任务队列")
    parser.add_argument("--config", default=None, help="配置文件路径（默认 config.yaml）")
    args = parser.parse_args(argv)

    settings = load_settings(args.config)
    if settings.source is None:
        print("[警告] 未找到 config.yaml，使用内置默认配置（可能无法连接 Google Sheets）。")

    log_file = _setup_logging(settings)
    logger.info("使用配置: %s", settings.source)

    if args.detect:
        return cmd_detect(settings)
    return cmd_run(settings)


if __name__ == "__main__":
    raise SystemExit(main())