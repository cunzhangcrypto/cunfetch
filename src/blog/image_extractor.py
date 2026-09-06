"""从文章 HTML 中提取图片候选地址。

兼容常见形式：<img src>、data-src、data-original、srcset、相对/绝对/CDN/Lazy Load。
仅提取，不判有效性；有效性过滤交给 images.validator。
"""
from __future__ import annotations

import logging
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


def extract_image_urls(soup: BeautifulSoup, base_url: str) -> list[str]:
    """提取候选图片 URL，按文档出现顺序返回，已合并相对路径为绝对地址。"""
    candidates: list[str] = []

    for img in soup.find_all("img"):
        url = _first_image_url(img)
        if not url:
            continue
        resolved = _normalize(url, base_url)
        if resolved and resolved not in candidates:
            candidates.append(resolved)

    # 部分主题用 <picture><source srcset>
    for source in soup.find_all("source"):
        if source.get("srcset"):
            first = source["srcset"].split(",")[0].strip().split(" ")[0]
            resolved = _normalize(first, base_url)
            if resolved and resolved not in candidates:
                candidates.append(resolved)

    return candidates


def _first_image_url(img) -> str:
    """按优先级取第一个可用 URL。"""
    for attr in ("src", "data-src", "data-original", "data-url"):
        val = img.get(attr)
        if val and val.strip():
            return val.strip()
    return ""


def _normalize(url: str, base_url: str) -> str:
    """处理 srcset 内第一个候选、相对路径、协议相对路径。"""
    url = url.strip()
    if not url:
        return ""
    # 处理形如 "url 1x, url 2x" —— 取第一个
    first = url.split(",")[0].strip().split(" ")[0]
    if not first:
        return ""
    # 常见 SVG data-uri 图标一般不作为素材，直接跳过
    first = first.lower()
    if first.startswith("data:"):
        return ""
    return urljoin(base_url, first)