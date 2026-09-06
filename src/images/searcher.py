"""网络图片补充搜索。

仅当博客图片不足 target_count 时使用。搜索关键词从文章标题与正文提取。
第一版支持：
  - provider: "bing"  —— Bing Web Search API（需要 api_key）
  - provider: "google_cse" —— Google Custom Search API（需要 api_key + cx）
  - provider: "wikimedia" —— Wikimedia Commons MediaWiki API（免 key，返回可直接下载的图片 URL）
  - provider: "none"（默认）—— 不启用，直接返回空列表

未配置可用 key 时不发起网络搜索，只记日志并返回空。
"""
from __future__ import annotations

import logging

import requests

from ..netutil import make_session

logger = logging.getLogger(__name__)


class SearchError(RuntimeError):
    pass


def build_search_keywords(title: str, body_md: str = "") -> list[str]:
    """从标题与正文提取 1~3 个搜索关键词。

    不要直接把整篇标题当关键词。若可用则用 jieba 分词，
    否则回退到按标点/空白切分的轻量实现。
    """
    import re

    stopwords = {
        "的", "和", "与", "及", "几", "个", "好", "使用", "是", "了", "在",
        "最", "哪些", "推荐", "工具", "攻略", "教程", "指南", "怎么",
        "如何", "为什么", "是什么", "最好", "几款", "年",
    }

    snippet = re.sub(r"\s+", "", body_md or "")[:40]
    keyword_sets: list[tuple[str, int]] = []  # (text, weight)

    words = []
    try:
        import jieba

        jieba.setLogLevel(20)
        words = [w.strip() for w in jieba.cut(title, cut_all=False)]
    except Exception:  # noqa: BLE001  # jieba 未安装时降级
        words = re.split(r"[\s、，,。．.:：/\\+_\-\[\]（）()【】|]+", title)

    kept = [w for w in words if w and w not in stopwords and len(w) > 0]
    if kept:
        keyword_sets.append((" ".join(kept[:10]), 3))
    # 省去“2026”这类纯年份数字干扰
    kept_filtered = [w for w in kept if not (w.isdigit() and len(w) == 4)]
    if kept_filtered:
        keyword_sets.append((" ".join(kept_filtered[:10]), 2))
    if snippet:
        keyword_sets.append((snippet, 1))

    keyword_sets.sort(key=lambda x: -x[1])
    seen, out = set(), []
    for text, _ in keyword_sets:
        text = text.strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= 3:
            break
    return out


def search_images(
    keywords: list[str],
    settings,
    count: int,
    session: requests.Session | None = None,
) -> list[str]:
    """按关键词搜索 count 张可用的图片 URL。返回 URL 列表（可能少于 count）。"""
    provider = (settings.images.searcher.provider or "none").lower()
    if provider == "none":
        logger.info("未配置网络图片搜索 provider，跳过网络补充")
        return []

    own_session = session is None
    sess = session or make_session(settings)
    results: list[str] = []
    try:
        for kw in keywords:
            if len(results) >= count:
                break
            try:
                batch = {
                    "bing": _search_bing,
                    "google_cse": _search_google_cse,
                    "wikimedia": _search_wikimedia,
                }[provider](kw, settings, sess)
            except (SearchError, KeyError, requests.RequestException) as exc:
                logger.warning("图片搜索失败(%s): %s", provider, exc)
                continue
            for url in batch:
                if url not in results:
                    results.append(url)
                if len(results) >= count:
                    break
    finally:
        if own_session:
            sess.close()
    return results


def _search_bing(keyword, settings, session) -> list[str]:
    key = (settings.images.searcher.bing.api_key or "").strip()
    if not key:
        raise SearchError("bing api_key 未配置")
    params = {
        "q": keyword,
        "count": 10,
        "mkt": "zh-CN",
    }
    headers = {"Ocp-Apim-Subscription-Key": key}
    resp = session.get("https://api.bing.microsoft.com/v7.0/images/search", params=params, headers=headers, timeout=settings.network.timeout_seconds)
    resp.raise_for_status()
    data = resp.json()
    out = []
    for item in data.get("value", []):
        url = item.get("contentUrl") or item.get("thumbnailUrl")
        if url:
            out.append(url)
    return out


def _search_google_cse(keyword, settings, session) -> list[str]:
    key = (settings.images.searcher.google_cse.api_key or "").strip()
    cx = (settings.images.searcher.google_cse.cx or "").strip()
    if not key or not cx:
        raise SearchError("google_cse api_key/cx 未配置")
    params = {
        "q": keyword,
        "key": key,
        "cx": cx,
        "searchType": "image",
        "num": 10,
    }
    resp = session.get("https://www.googleapis.com/customsearch/v1", params=params, timeout=settings.network.timeout_seconds)
    resp.raise_for_status()
    data = resp.json()
    out = []
    for item in data.get("items", []):
        url = item.get("link") or item.get("image", {}).get("thumbnailLink")
        if url:
            out.append(url)
    return out


def _search_wikimedia(keyword, settings, session) -> list[str]:
    """Wikimedia Commons 图片搜索。免 key，返回可直接下载的图片 URL。

    使用 MediaWiki Action API，gsrnamespace=6（File 命名空间）保证拿到的是
    实际文件，而不是普通条目。prop=imageinfo 附带文件真实 URL。
    """
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": keyword,
        "gsrnamespace": 6,
        "gsrlimit": 10,
        "prop": "imageinfo",
        "iiprop": "url",
        "iiurlwidth": 800,
    }
    resp = session.get(
        "https://commons.wikimedia.org/w/api.php",
        params=params,
        timeout=settings.network.timeout_seconds,
    )
    resp.raise_for_status()
    data = resp.json()
    out = []
    pages = data.get("query", {}).get("pages", {})
    for page in pages.values():
        info = (page.get("imageinfo") or [None])[0]
        if not info:
            continue
        # 优先用缩略图(更小更快)，没有再用原图
        url = info.get("thumburl") or info.get("url")
        if url:
            out.append(url)
    return out