"""端到端冒烟测试：本地 HTTP 服务模拟博客文章与图片，验证完整采集流程。

运行：python -m pytest tests/ -v
需要本机已安装：pytest, Pillow, beautifulsoup4, lxml, requests, tenacity, PyYAML
（feedparser / googleapiclient 在本测试中不参与。）
"""
from __future__ import annotations

import functools
import http.server
import os
import sys
import threading
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config.settings import Settings  # noqa: E402
from src.interfaces.task_provider import PENDING  # noqa: E402
from src.storage.local import LocalStorage  # noqa: E402
from src.tasks.manager import TaskManager  # noqa: E402


# ---------- 内存版任务队列（隔离 Google Sheets 依赖） ----------
class MemoryProvider:
    def __init__(self):
        self.tasks = {}

    def create(self, task):
        if task.url in self.tasks:
            return False
        self.tasks[task.url] = task
        return True

    def get_pending_tasks(self):
        return [t for t in self.tasks.values() if t.status == PENDING]

    def get_task(self, url):
        return self.tasks.get(url)

    def update(self, task):
        self.tasks[task.url] = task
        return True

    def close(self):
        pass


# ---------- 本地 HTTP 服务 ----------
class FixtureServer:
    def __init__(self, root: Path):
        self.root = root
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def fixture_server(tmp_path: Path):
    """准备文章 HTML + 3 张图片（2 大 1 极小）。"""
    imgs = tmp_path / "imgs"
    imgs.mkdir()
    Image.new("RGB", (640, 400), "red").save(imgs / "a.png")
    Image.new("RGB", (640, 400), "blue").save(imgs / "b.webp")
    # 1x1 tracking pixel，应被过滤
    Image.new("RGB", (1, 1), "white").save(imgs / "pixel.png")

    (tmp_path / "article.html").write_text(
        "<!doctype html><html><head>"
        "<title>示例文章标题</title>"
        '<meta property="article:published_time" content="2026-09-03T08:30:00+08:00">'
        "</head><body><article>"
        "<h1>示例文章标题</h1>"
        '<p>这是正文段落。</p>'
        '<img src="/imgs/a.png">'
        '<img data-src="/imgs/b.webp">'
        '<img src="/imgs/pixel.png">'
        "</article></body></html>",
        encoding="utf-8",
    )

    srv = FixtureServer(tmp_path)
    base = srv.start()
    try:
        yield base
    finally:
        srv.stop()


def _make_settings(root: Path) -> Settings:
    data = {
        "storage": {"root": str(root / "out")},
        "images": {
            "target_count": 5,
            "allowed_formats": ["jpg", "jpeg", "png", "webp"],
            "min_dimension": 100,
            "min_file_bytes": 100,
            "download_retries": 2,
            "download_timeout_seconds": 10,
            "searcher": {
                "provider": "none",
                "bing": {"api_key": ""},
                "google_cse": {"api_key": "", "cx": ""},
            },
        },
        "network": {"timeout_seconds": 10, "user_agent": "test-agent"},
        "logging": {"level": "INFO"},
    }
    return Settings(data, source="memory")


def test_end_to_end_capture(fixture_server, tmp_path: Path):
    base = fixture_server
    settings = _make_settings(tmp_path)
    provider = MemoryProvider()

    from src.interfaces.task_provider import Task

    task = Task.new(url=f"{base}/article.html", title="示例文章标题")
    provider.create(task)

    manager = TaskManager(settings, provider, storage=LocalStorage(str(settings.storage.root)))
    result = manager.process_task(task)

    assert result.status == "completed", result.error
    # 2 张有效博客图 + 0 张网络图（未配置搜索）
    assert result.blog_images == 2, result.blog_images
    assert result.web_images == 0
    assert result.total_images == 2

    article_dir = Path(result.local_path)
    assert (article_dir / "article.md").exists()
    assert (article_dir / "info.json").exists()
    assert (article_dir / "source.txt").exists()

    images = sorted(p.name for p in (article_dir / "images").glob("*"))
    assert images == ["01.png", "02.webp"], images

    src_text = (article_dir / "source.txt").read_text(encoding="utf-8")
    assert "Source Type: Blog" in src_text
    assert "article.html" in src_text

    info = (article_dir / "info.json").read_text(encoding="utf-8")
    assert '"total_image_count": 2' in info


def test_idempotent_no_duplicate(fixture_server, tmp_path: Path):
    """同一 URL 已存在时 create 返回 False（幂等）。"""
    base = fixture_server
    from src.interfaces.task_provider import Task

    provider = MemoryProvider()
    t1 = Task.new(url=f"{base}/article.html")
    t2 = Task.new(url=f"{base}/article.html")
    assert provider.create(t1) is True
    assert provider.create(t2) is False