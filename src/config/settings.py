"""CunFetch 配置加载模块。

从 config.yaml 读取配置，未提供时使用 config.example.yaml 的默认值。
所有敏感信息（Google API、Service Account）都不允许硬编码/提交。
"""
from __future__ import annotations

import copy
import os
import traceback
from pathlib import Path
from typing import Any

import yaml

# 配置查找顺序：显式传入路径 > ./config.yaml > ./config.example.yaml
CONFIG_CANDIDATES = ("config.yaml", "config.example.yaml")


class ConfigError(RuntimeError):
    """配置读取/解析失败。"""


def _defaults() -> dict[str, Any]:
    """内置默认配置，与文档第六~四十二节保持一致。"""
    return {
        "blog": {
            "url": "https://example.com",
            "rss": None,
            "sitemap": None,
            "use_rss": True,
            "use_sitemap": False,
        },
        "storage": {
            "root": "D:/CunContent",
            "log_dir": "logs",
        },
        "images": {
            "target_count": 5,
            "allowed_formats": ["jpg", "jpeg", "png", "webp"],
            "min_dimension": 100,
            "min_file_bytes": 1024,
            "download_retries": 3,
            "download_timeout_seconds": 15,
            "searcher": {
                "provider": "none",
                "bing": {"api_key": ""},
                "google_cse": {"api_key": "", "cx": ""},
            },
        },
        "sheets": {
            "spreadsheet_id": "",
            "sheet_name": "CunFetch Tasks",
            "credentials_path": "D:/CunContent/credentials/service-account.json",
            "credentials_env": "CUNFETCH_SHEETS_CREDENTIALS",
        },
        "network": {
            "timeout_seconds": 30,
            "user_agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0 Safari/537.36"
            ),
            "proxy": "",   # 可选：外网代理，如 http://127.0.0.1:10808 或 socks5h://127.0.0.1:10809
        },
        "logging": {"level": "INFO"},
        "schedule": {"timezone": "Asia/Shanghai", "time": "09:05"},
        "runner": {"detached_cron_utc": "0 1 * * *"},
    }


def _deep_merge(base: dict, override: dict) -> dict:
    """递归合并 override 到 base，返回新字典。"""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


class Settings:
    """对配置字典提供属性式访问：settings.images.target_count。"""

    def __init__(self, data: dict[str, Any], source: str | None = None):
        self._data = data
        self.source = source

    def __getattr__(self, name: str) -> Any:
        data = self._data
        try:
            value = data[name]
        except KeyError as exc:  # pragma: no cover - defensive
            raise AttributeError(f"配置缺少字段: {name}") from exc
        if isinstance(value, dict):
            return Settings(value)
        return value

    def raw(self) -> dict[str, Any]:
        return self._data

    def as_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self._data)


def load_settings(config_path: str | None = None) -> Settings:
    """加载配置。优先使用传入路径。

    合并顺序：内置默认值 <- config.yaml（若存在）。
    如果 config.yaml 不存在且未指定路径，则回退到 example 模板，
    保证程序可以“无配置先启动”但允许打印提示。
    """
    merged = _defaults()
    source: str | None = None

    if config_path:
        path = Path(config_path)
    else:
        path = None
        for candidate in CONFIG_CANDIDATES:
            p = Path(candidate)
            if p.is_file():
                path = p
                break

    if path is not None and path.is_file():
        try:
            text = path.read_text(encoding="utf-8")
            user_conf = yaml.safe_load(text) or {}
            merged = _deep_merge(merged, user_conf)
            source = str(path)
        except Exception as exc:  # noqa: BLE001
            # 配置坏掉时提供一个可读错误，但依然返回默认值并告警。
            traceback.print_exc()
            raise ConfigError(f"无法解析配置文件 {path}: {exc}") from exc

    return Settings(merged, source=source)


def resolve_storage_root(settings: Settings) -> str:
    """把 storage.root / storage.log_dir 展开为绝对路径。"""
    root = os.path.abspath(os.path.expanduser(settings.storage.root))
    return root