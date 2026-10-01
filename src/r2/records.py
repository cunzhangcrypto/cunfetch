"""本地落盘记录管理：幂等 state + 可读 jsonl 记录。

- state 文件 `.inbox_state.json`：按对象 key 记录是否已完整落盘（size/etag/done），避免残缺文件被误判完成。
- records 文件 `.inbox_records.jsonl`：每次落盘追加一行，供排查与回溯。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger("cunfetch.r2.records")

STATE_FILE = ".inbox_state.json"
RECORDS_FILE = ".inbox_records.jsonl"


def _utcnow() -> str:
    return datetime.now().isoformat(timespec="seconds")


class PullRecords:
    def __init__(self, local_root: Path):
        self.root = Path(local_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_file = self.root / STATE_FILE
        self.records_file = self.root / RECORDS_FILE
        self._state = {}
        if self.state_file.is_file():
            try:
                self._state = json.loads(self.state_file.read_text(encoding="utf-8")) or {}
            except Exception as exc:  # noqa: BLE001
                logger.warning("state 文件损坏，重置: %s | %s", self.state_file, exc)
                self._state = {}

    def get(self, key: str) -> dict | None:
        return self._state.get(key)

    def is_done(self, key: str, etag: str, size: int, dest: Path) -> bool:
        rec = self._state.get(key)
        if not rec or not rec.get("done"):
            return False
        if rec.get("etag") != etag:
            return False
        try:
            return dest.is_file() and dest.stat().st_size == int(rec.get("size", -1))
        except Exception:  # noqa: BLE001
            return False

    def record(self, key: str, dest: Path, etag: str, size: int, extra: dict | None = None) -> None:
        entry = {
            "key": key,
            "local": str(dest),
            "size": size,
            "etag": etag,
            "done": True,
            "pulled_at": _utcnow(),
            **(extra or {}),
        }
        self._state[key] = entry
        self._write_state()
        self._append_record(entry)

    def mark_missing(self, key: str, extra: dict | None = None) -> None:
        """记录一个允许缺失的文件（如 platforms.json 不存在），并写状态。"""
        entry = {
            "key": key,
            "local": None,
            "size": 0,
            "etag": "",
            "done": False,
            "missing": True,
            "pulled_at": _utcnow(),
            **(extra or {}),
        }
        self._state.setdefault(key, entry)
        self._append_record(entry)

    def _write_state(self) -> None:
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.state_file)

    def _append_record(self, entry: dict) -> None:
        try:
            with self.records_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as exc:  # noqa: BLE001
            logger.warning("写入记录失败(不影响主流程): %s", exc)