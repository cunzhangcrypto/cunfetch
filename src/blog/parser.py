"""文章页面解析：提取标题、发布时间、正文，并尽量转为 Markdown。"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from ..netutil import get_with_retry, make_session

logger = logging.getLogger(__name__)


class ParsedArticle:
    __slots__ = ("url", "title", "published_at", "markdown", "html", "soup")

    def __init__(self, url, title, published_at, markdown, html, soup):
        self.url = url
        self.title = title
        self.published_at = published_at
        self.markdown = markdown
        self.html = html
        self.soup = soup


def parse_article(url: str, settings, session: requests.Session | None = None) -> ParsedArticle:
    """下载并解析一篇文章。"""
    own_session = session is None
    sess = session or make_session(settings)
    try:
        resp = get_with_retry(sess, url, settings)
        resp.raise_for_status()
        html = _decode_html(resp)
        soup = BeautifulSoup(html, "lxml")

        title = _extract_title(soup, url)
        published_at = _extract_published_at(soup)
        markdown = html_to_markdown(soup, url)

        return ParsedArticle(
            url=url,
            title=title,
            published_at=published_at,
            markdown=markdown,
            html=html,
            soup=soup,
        )
    finally:
        if own_session:
            sess.close()


def _decode_html(resp) -> str:
    """正确解码 HTML 正文。

    优先按文档内声明的 <meta charset> 解码；仅当文档首段无声明时才用
    requests 的猜测（常因缺少 Content-Type: charset 而误判为 ISO-8859-1）。
    """
    raw = resp.content
    if not raw:
        return resp.text or ""
    head = raw[:4096].decode("latin-1", errors="ignore").lower()
    charset = None
    m = re.search(r"charset[=\s]+[\"']?([a-z0-9\-_]+)", head)
    if m:
        charset = m.group(1)
    if charset and charset.lower() in ("utf-8", "utf8"):
        return raw.decode("utf-8", errors="replace")
    if charset:
        try:
            return raw.decode(charset, errors="replace")
        except LookupError:
            pass
    return resp.text


def _extract_title(soup: BeautifulSoup, fallback_url: str) -> str:
    # 文章页优先取正文标题 h1；无 h1 时取 <title>（页面标题，通常=文章标题）。
    # 部分博客把 og:title 写成站点模板（如本站），故 og:title 放最后。
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return h1.get_text(strip=True)
    if soup.title and soup.title.get_text(strip=True):
        return soup.title.get_text(strip=True)
    for sel in ("meta[property='og:title']", "meta[name='twitter:title']", "meta[name='title']"):
        tag = soup.select_one(sel)
        if tag and tag.get("content"):
            return tag.get("content").strip()
    return fallback_url


def _extract_published_at(soup: BeautifulSoup) -> str:
    """尽可能提取发布时间，返回标准化的 ISO 或原始字符串。"""
    raw = ""
    for sel in (
        "meta[property='article:published_time']",
        "meta[property='og:published_time']",
        "meta[name='pubdate']",
        "meta[itemprop='datePublished']",
        "time[itemprop='datePublished']",
    ):
        tag = soup.select_one(sel)
        if tag is None:
            continue
        raw = (tag.get("content") or tag.get("datetime") or "").strip()
        if raw:
            break
    if not raw:
        return ""

    normalized = raw.strip()
    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(normalized, fmt)
            return dt.isoformat()
        except ValueError:
            continue
    return normalized


def html_to_markdown(soup: BeautifulSoup, base_url: str, content_selector: str | None = None) -> str:
    """把正文转为 Markdown。

    优先提取 <article> 或 meta og:description 之外的正文容器；找不到则整页落盘。
    生成内容仅为“尽可能”转换，不强求完美（需求第二十五节）。
    """
    main = None
    if content_selector:
        main = soup.select_one(content_selector)
    if main is None:
        for sel in ("article", "[role='main']", ".post-content", ".entry-content", ".content", "main"):
            node = soup.select_one(sel)
            if node is not None:
                main = node
                break
    if main is None:
        main = soup.body if soup.body else soup

    md = _element_to_md(main, base_url)
    return md.strip() or ""


def _element_to_md(node, base_url: str) -> str:
    """递归把节点转成 Markdown 简版。"""
    lines: list[str] = []
    for child in node.contents:
        if not hasattr(child, "name"):
            text = _clean_text(child)
            if text:
                lines.append(text)
            continue
        name = getattr(child, "name", None)
        if name in ("script", "style", "noscript", "nav", "header", "footer", "aside", "form"):
            continue
        # 块级标题
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            lvl = int(name[1])
            lines.append(f"{'#' * lvl} {_clean_text(child.get_text())}")
        elif name in ("p", "div", "section", "li"):
            text = _clean_text(child.get_text())
            if text:
                lines.append(text)
        elif name == "img":
            src = child.get("src") or child.get("data-src") or child.get("srcset", "").split(" ")[0]
            if src:
                lines.append(f"![{child.get('alt', '')}]({urljoin(base_url, src)})")
        elif name == "ul":
            lines.append(_list_to_md(child, base_url, "-"))
        elif name == "ol":
            lines.append(_list_to_md(child, base_url, "1."))
        elif name == "blockquote":
            inner = _clean_text(child.get_text())
            if inner:
                lines.append(f"> {inner}")
        elif name in ("pre", "code"):
            lines.append(f"```\n{_clean_text(child.get_text())}\n```")
        elif name == "table":
            lines.append(_table_to_md(child))
        elif name == "hr":
            lines.append("---")
        elif name == "a":
            txt = _clean_text(child.get_text())
            href = child.get("href")
            if txt and href:
                lines.append(f"[{txt}]({urljoin(base_url, href)})")
    return "\n\n".join([ln for ln in lines if ln])


def _list_to_md(ul, base_url: str, marker: str) -> str:
    items = []
    counter = 0
    for li in ul.find_all("li", recursive=False):
        counter += 1
        text = _clean_text(li.get_text())
        m = str(counter) + "." if marker.startswith("1") else marker
        items.append(f"{m} {text}")
    return "\n".join(items)


def _table_to_md(table) -> str:
    rows = []
    for tr in table.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
        rows.append("| " + " | ".join(cells) + " |")
    if not rows:
        return ""
    header, body = rows[0], rows[1:]
    sep = "|" + " --- |" * (rows[0].count("|") - 1)
    out = [header, sep] + body
    return "\n".join(out)


def _clean_text(text: str) -> str:
    import re

    parts = [p for p in text.split("\n")]
    joined = " ".join(parts)
    joined = re.sub(r"\s+", " ", joined)
    return joined.strip()