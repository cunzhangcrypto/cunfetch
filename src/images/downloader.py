"""图片下载。

下载失败自动重试（最多 settings.images.download_retries 次），
单张失败不中断整篇文章，由调用方决定是否继续其它图片。
"""
from __future__ import annotations

import logging
from pathlib import Path

import requests

from ..netutil import get_with_retry, make_session

logger = logging.getLogger(__name__)


def download_image(
    url: str,
    dest_path: str,
    settings,
    session: requests.Session | None = None,
) -> bool:
    """下载单张图片到 dest_path。校验通过（可解析且尺寸达标）返回 True。"""
    own_session = session is None
    sess = session or make_session(settings)
    try:
        resp = get_with_retry(sess, url, settings, timeout=settings.images.download_timeout_seconds, stream=True)
        if resp.status_code != 200:
            logger.info("图片非 200: %s -> %s", resp.status_code, url)
            return False

        content = b""
        for chunk in resp.iter_content(chunk_size=65536):
            content += chunk
        resp.close()

        if not content:
            logger.info("图片内容为空: %s", url)
            return False

        # 根据 Content-Type 或 URL 扩展名决定后缀
        parent = Path(dest_path).parent
        parent.mkdir(parents=True, exist_ok=True)
        (Path(dest_path)).write_bytes(content)

        # 实筛：尺寸 + 文件大小
        from .validator import is_reasonable_file_size, is_valid_downloaded

        if not is_valid_downloaded(dest_path, settings) or not is_reasonable_file_size(dest_path, settings):
            logger.info("图片未通过实筛，删除: %s", dest_path)
            try:
                Path(dest_path).unlink(missing_ok=True)
            except OSError:
                pass
            return False
        return True
    except requests.RequestException as exc:
        logger.info("图片下载失败: %s (%s)", url, exc)
        return False
    finally:
        if own_session:
            sess.close()


def pick_extension(url: str, settings, content_type: str = "") -> str:
    """从 URL 路径或 Content-Type 推断扩展名，仅允许白名单格式。

    先去掉 #fragment（如 #blurhash=...）与 query，避免污染扩展名判断。
    """
    allowed = {fmt.lstrip(".") for fmt in settings.images.allowed_formats}
    clean = url.split("#", 1)[0].split("?", 1)[0].lower()
    tail = clean.rsplit("/", 1)[-1]
    if "." in tail:
        ext = tail.rsplit(".", 1)[-1]
        if ext in allowed:
            return ext
    if content_type:
        mapping = {
            "image/jpeg": "jpg",
            "image/jpg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/gif": "gif",
        }
        for key, val in mapping.items():
            if key in content_type:
                return val if val in allowed else ""
    return ""