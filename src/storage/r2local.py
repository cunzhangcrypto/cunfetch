"""R2 收件箱本地目录规划。

把远端对象键 inbox/<date>/<slot>/<slug>/<file> 映射到本地：
    D:/CunContent/inbox/<yyyymmdd>_<slot>_<slug>/<file>
复用 storage.local.sanitize_filename 保证 slug 安全用于目录名。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from ..storage.local import sanitize_filename


def target_dir_for(local_root, date: str, slot: str, slug: str) -> Path:
    safe_slug = sanitize_filename(slug, "untitled")
    return Path(local_root) / f"{date}_{slot}_{safe_slug}"


def write_info_json(target_dir: Path, info: dict) -> Path:
    p = target_dir / "info.json"
    p.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def parse_date_from_key(key: str):
    """从对象键中提取 date/slot/slug。规则 inbox/<date>/<slot>/<slug>/<file>。"""
    parts = key.split("/")
    if len(parts) < 5:
        return None
    return {"date": parts[1], "slot": parts[2], "slug": parts[3], "file": parts[4]}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")