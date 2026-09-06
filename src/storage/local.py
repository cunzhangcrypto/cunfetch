"""本地素材归档。

对每篇文章创建目录（Windows 文件名安全处理），保存
article.md / info.json / source.txt / images/。
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path

# Windows 非法文件名字符
_INVALID_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def sanitize_filename(name: str, fallback: str = "untitled") -> str:
    """把文章标题清洗为可安全用于 Windows 目录名的字符串。"""
    cleaned = _INVALID_CHARS.sub("_", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if not cleaned:
        cleaned = fallback
    if len(cleaned) > 90:  # 避免路径过长
        cleaned = cleaned[:90].rstrip(" .")
    # 去掉 Windows 保留名（带扩展名的保留名同样危险）
    stem = cleaned.lower().split(".")[0]
    if stem in _RESERVED:
        cleaned = "_" + cleaned
    return cleaned


def safe_title_dir(date_prefix: str, title: str) -> str:
    """目录名：YYYY-MM-DD_文章标题。"""
    base = sanitize_filename(title, "untitled-article")
    return f"{_extract_date(date_prefix)}_{base}"


def _extract_date(text: str) -> str:
    """从任意发布时间文本中稳健提取 YYYY-MM-DD，找不到则用今天。"""
    m = re.search(r"\d{4}-\d{2}-\d{2}", text or "")
    if m:
        return m.group(0)
    return datetime.now().strftime("%Y-%m-%d")


class LocalStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()

    def create_article_dir(self, task) -> Path:
        """创建单篇文章独立目录：D:/CunContent/YYYY-MM-DD_标题/"""
        date_prefix = (task.published_at or "").split("T")[0] or datetime.now().strftime("%Y-%m-%d")
        dir_name = safe_title_dir(date_prefix, task.title or sanitize_filename(task.url))
        target = self.root / dir_name
        target.mkdir(parents=True, exist_ok=True)
        return target

    def images_dir(self, article_dir: Path) -> Path:
        img = article_dir / "images"
        img.mkdir(parents=True, exist_ok=True)
        return img

    def save_article_md(self, article_dir: Path, markdown: str, title: str, url: str, published_at: str) -> Path:
        content = [
            f"# {title}",
            "",
            f"- 原文地址：{url}",
            f"- 发布时间：{published_at}",
            "",
            "---",
            "",
            markdown,
            "",
        ]
        path = article_dir / "article.md"
        path.write_text("\n".join(content), encoding="utf-8")
        return path

    def save_info_json(self, article_dir: Path, info: dict) -> Path:
        path = article_dir / "info.json"
        path.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def save_source_txt(self, article_dir: Path, article_url: str, image_sources: list[dict]) -> Path:
        """image_sources: [{filename, type, url}]"""
        lines = ["Article Source:", article_url, "", "Images:", ""]
        for src in image_sources:
            lines.append(src["filename"])
            lines.append(f"Source Type: {src['type']}")
            lines.append(f"Source URL: {src['url']}")
            lines.append("")
        path = article_dir / "source.txt"
        path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        return path