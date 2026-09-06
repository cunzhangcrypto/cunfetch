"""图片有效性过滤。

需求第十九、二十一节：过滤 Logo/favicon/头像/图标/tracking pixel/装饰图/极小图/重复图。
采用两类规则：
  1. 基于 URL 只读预筛（不下载）
  2. 下载后基于 Pillow 尺寸 + 文件大小实筛
"""
from __future__ import annotations

import logging
import re
from urllib.parse import unquote, urlsplit

logger = logging.getLogger(__name__)

# URL 中出现即认为“无关/装饰”的片段
BAD_PATTERNS = (
    "favicon", "logo", "avatar", "icon", "sprite", "badge",
    "sticker", "emoji", "pixel", "tracking", "spacer", "blank.gif",
    "1x1", "px.gif", "banner-ad", "advert", "adsense",
    "google-analytics", "placeholder", "thumbnail",
)


def is_valid_url(url: str, settings) -> bool:
    """基于 URL 的只读预筛。不涉及网络请求。"""
    if not url:
        return False
    lower = url.lower()
    try:
        split = urlsplit(lower)
    except ValueError:
        return False
    if split.scheme not in ("http", "https"):
        return False
    path = unquote(split.path).lower()
    ext = path.rsplit(".", 1)[-1] if "." in path.rsplit("/", 1)[-1] else ""
    allowed = [fmt.lstrip(".") for fmt in settings.images.allowed_formats]
    if ext and ext not in allowed:
        return False
    for bad in BAD_PATTERNS:
        if bad in path:
            return False
    return True


def is_valid_downloaded(path: str, settings) -> bool:
    """下载后实筛：尺寸、类型。"""
    from PIL import Image

    try:
        with Image.open(path) as img:
            w, h = img.size
            min_dim = int(settings.images.min_dimension)
            if w < min_dim or h < min_dim:
                logger.debug("图片尺寸过小: %s (%sx%s)", path, w, h)
                return False
            return True
    except OSError as exc:
        logger.debug("无法解析图片或损坏: %s (%s)", path, exc)
        return False


def is_reasonable_file_size(path: str, settings) -> bool:
    import os

    min_bytes = int(settings.images.min_file_bytes)
    try:
        return os.path.getsize(path) >= min_bytes
    except OSError:
        return False