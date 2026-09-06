"""博客新文章检测。

优先使用 RSS；无 RSS 时用 sitemap.xml；可两者结合兜底。
返回文章候选列表（url + title + published_at），去重由任务队列负责。
"""
from __future__ import annotations

import logging
import re
from urllib.parse import unquote, urljoin

import feedparser
import requests
from bs4 import BeautifulSoup

from ..netutil import get_with_retry, make_session

logger = logging.getLogger(__name__)


class DetectedArticle:
    __slots__ = ("url", "title", "published_at")

    def __init__(self, url: str, title: str = "", published_at: str = ""):
        self.url = url
        self.title = title
        self.published_at = published_at

    def as_dict(self) -> dict:
        return {"url": self.url, "title": self.title, "published_at": self.published_at}


def detect_new_articles(settings, session: requests.Session | None = None) -> list[DetectedArticle]:
    """检测博客新文章。返回按发布时间新→旧排序的列表（不保证排序，仅去重）。"""
    own_session = session is None
    sess = session or make_session(settings)
    articles: dict[str, DetectedArticle] = {}
    try:
        blog_cfg = settings.blog
        if blog_cfg.use_rss and blog_cfg.rss:
            _from_feed(sess, settings, str(blog_cfg.rss), articles)
        if blog_cfg.use_sitemap and blog_cfg.sitemap:
            _from_sitemap(sess, settings, str(blog_cfg.sitemap), articles)
        if not articles and blog_cfg.rss and not blog_cfg.use_sitemap:
            # 无 RSS 结果时兜底 sitemap
            if blog_cfg.sitemap:
                _from_sitemap(sess, settings, str(blog_cfg.sitemap), articles)
    finally:
        if own_session:
            sess.close()
    return list(articles.values())


def _from_feed(session, settings, feed_url: str, out: dict) -> None:
    try:
        resp = get_with_retry(session, feed_url, settings)
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
    except requests.RequestException as exc:
        logger.warning("RSS 获取失败: %s %s", feed_url, exc)
        return

    for entry in parsed.entries:
        link = getattr(entry, "link", None) or ""
        if not link:
            continue
        title = getattr(entry, "title", "") or ""
        published = _normalize_published(entry) or (
            getattr(entry, "published", "") or getattr(entry, "updated", "") or ""
        )
        key = link.strip()
        if key and key not in out:
            out[key] = DetectedArticle(url=key, title=title, published_at=published)


def _normalize_published(entry) -> str:
    """把 RSS 的发布时间规范化为 ISO 字符串。

    feedparser 提供 published_parsed（struct_time），据此生成 YYYY-MM-DDTHH:MM:SS，
    避免用原始文本（如 "Sat, 29 Aug 2026 ... GMT"）污染本地目录名。
    """
    st = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
    if not st:
        return ""
    try:
        from datetime import datetime

        dt = datetime(*st[:6])
        return dt.isoformat()
    except (TypeError, ValueError):
        return ""


def _from_sitemap(session, settings, sitemap_url: str, out: dict) -> None:
    try:
        resp = get_with_retry(session, sitemap_url, settings)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Sitemap 获取失败: %s %s", sitemap_url, exc)
        return

    # 支持两种：<urlset> 的 <url><loc></loc>，或 sitemap index 的 <sitemap><loc></loc>
    soup = BeautifulSoup(resp.content, "lxml")
    for loc in soup.find_all("loc"):
        url = (loc.get_text() or "").strip()
        if not url:
            continue
        # UUID / 含大括号 / 明显非文章路径 的价值较低，仍保留，交给去重与解析
        title = _guess_title_from_url(url)
        key = url
        if key not in out:
            out[key] = DetectedArticle(url=key, title=title)


def _guess_title_from_url(url: str) -> str:
    """从 URL 末段尝试推导标题（用于 sitemap 缺少 title 的情形）。"""
    try:
        path = unquote(url).rstrip("/")
        tail = path.rsplit("/", 1)[-1]
        tail = tail.split("?")[0].split("#")[0]
        if not tail or tail.lower().endswith((".html", ".htm")):
            tail = tail[:-5] if tail.lower().endswith(".html") else tail
        # 去掉语义化 ID 前后缀，做初步清洗
        tail = re.sub(r"[-_+]", " ", tail).strip().title()
        return tail
    except Exception:  # noqa: BLE001
        return ""