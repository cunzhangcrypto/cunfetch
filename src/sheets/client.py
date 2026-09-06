"""Google Sheets 任务队列实现（第一阶段）。

通过 Service Account 访问 Google Sheets 的「CunFetch Tasks」表。
支持两种凭证来源：
  1. 本地 Service Account JSON 文件路径（sheets.credentials_path）
  2. 环境变量中的 JSON 字符串（sheets.credentials_env，供 GitHub Actions 使用）

凭证内容绝不可公开/提交，鉴权失败会抛错并明确提示。
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

from google.oauth2 import service_account

try:
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError  # type: ignore
except Exception:  # pragma: no cover - 缺少依赖时的报错引导
    build = None
    HttpError = Exception

from ..interfaces.task_provider import (
    PENDING,
    PROCESSING,
    COMPLETED,
    FAILED,
    Task,
    TaskProvider,
)

SHEET_SCOPE = "https://www.googleapis.com/auth/spreadsheets"

# 表头与需求第十二节保持一致
HEADERS = [
    "task_id",
    "title",
    "url",
    "published_at",
    "status",
    "blog_images",
    "web_images",
    "total_images",
    "local_path",
    "created_at",
    "updated_at",
    "error",
]


class SheetsError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _parse_values(rows: list[list]) -> list[Task]:
    """把二维数组（含表头）解析为 Task 列表，跳过空行与表头。"""
    tasks: list[Task] = []
    if not rows or not rows[0]:
        return tasks
    header = [str(h).strip() for h in rows[0]]
    for row in rows[1:]:
        if not row or all(str(c).strip() == "" for c in row):
            continue
        record: dict[str, str] = {}
        for idx, name in enumerate(header):
            record[name] = str(row[idx]).strip() if idx < len(row) else ""
        if not record.get("url"):
            continue
        try:
            tasks.append(
                Task(
                    task_id=record.get("task_id", ""),
                    title=record.get("title", ""),
                    url=record.get("url", ""),
                    published_at=record.get("published_at", ""),
                    status=record.get("status", PENDING),
                    blog_images=int(record.get("blog_images", 0) or 0),
                    web_images=int(record.get("web_images", 0) or 0),
                    total_images=int(record.get("total_images", 0) or 0),
                    local_path=record.get("local_path", ""),
                    created_at=record.get("created_at", ""),
                    updated_at=record.get("updated_at", ""),
                    error=record.get("error", ""),
                )
            )
        except (TypeError, ValueError):
            continue
    return tasks


class GoogleSheetsProvider(TaskProvider):
    """基于 Google Sheets 的任务队列实现。"""

    def __init__(self, config) -> None:
        self._settings = config
        self._spreadsheet_id = str(config.sheets.spreadsheet_id or "").strip()
        if not self._spreadsheet_id:
            raise SheetsError("配置缺失 sheets.spreadsheet_id，无法连接 Google Sheets")
        self.sheet_name = config.sheets.sheet_name or "CunFetch Tasks"
        self._service = None
        self._range_prefix = None

    # ---------- 鉴权 ----------
    def _build_credentials(self):
        creds_path = self._settings.sheets.credentials_path
        creds_env = self._settings.sheets.credentials_env
        info: dict | None = None

        if creds_path and isinstance(creds_path, str) and os.path.isfile(creds_path):
            info = json.loads(Path(creds_path).read_text(encoding="utf-8"))
        elif creds_env and isinstance(creds_env, str) and os.environ.get(creds_env):
            info = json.loads(os.environ[creds_env])
        else:
            raise SheetsError(
                "未找到 Service Account 凭证，请设置 sheets.credentials_path "
                "或环境变量 CUNFETCH_SHEETS_CREDENTIALS"
            )

        # Service Account 通过 JSON info 直接构建，无需 refresh 请求
        return service_account.Credentials.from_service_account_info(
            info, scopes=[SHEET_SCOPE]
        )

    @property
    def _client(self):
        if self._service is None:
            if build is None:
                raise SheetsError("缺少依赖 googleapiclient，请先安装 requirements.txt")

            creds = self._build_credentials()
            # 新版 googleapiclient 内部走 requests/httplib2 传输，直接读环境代理。
            from ..netutil import ensure_proxy_env

            ensure_proxy_env(self._settings)
            self._service = build("sheets", "v4", credentials=creds)
        return self._service

    @property
    def _range(self) -> str:
        # 始终从 A1 读取，覆盖整表
        if self._range_prefix is None:
            col = chr(ord("A") + len(HEADERS) - 1)
            self._range_prefix = f"{self.sheet_name}!A1:{col}"
        return self._range_prefix

    # ---------- 读取 ----------
    def _read_all(self) -> list[Task]:
        result = (
            self._client.spreadsheets()
            .values()
            .get(spreadsheetId=self._spreadsheet_id, range=self._range)
            .execute()
        )
        rows = result.get("values", [])
        return _parse_values(rows)

    def get_pending_tasks(self) -> list[Task]:
        return [t for t in self._read_all() if t.status == PENDING]

    def get_task(self, url: str) -> Task | None:
        for t in self._read_all():
            if t.url.strip() == url.strip():
                return t
        return None

    # ---------- 写入 ----------
    def create(self, task: Task) -> bool:
        """按 url 去重插入新任务，返回是否真正新建。"""
        existing = self.get_task(task.url)
        if existing is not None:
            return False

        row = _task_to_row(task, with_task_id=True)
        self._client.spreadsheets().values().append(
            spreadsheetId=self._spreadsheet_id,
            range=self._range,
            valueInputOption="USER_ENTERED",
            body={"values": [row]},
        ).execute()
        return True

    def update(self, task: Task) -> bool:
        rows = self._read_raw_rows()
        for idx, row in enumerate(rows):
            if idx == 0:
                continue  # 表头
            if len(row) >= 4 and row[2].strip() == task.url.strip():
                values = _task_to_row(task, with_task_id=False)
                # 仅在行不足时补齐
                while len(values) < len(HEADERS):
                    values.append("")
                for col, value in enumerate(values):
                    r = f"{self.sheet_name}!{chr(ord('A') + col)}{idx + 1}"
                    self._client.spreadsheets().values().update(
                        spreadsheetId=self._spreadsheet_id,
                        range=r,
                        valueInputOption="RAW",
                        body={"values": [[str(value)]]},
                    ).execute()
                return True
        # 没有匹配行则按新建插入（幂等更新兜底）
        self.create(task)
        return True

    def mark_status(self, task: Task, status: str, error: str = "", **fields):
        """便捷方法：更新任务状态位与结果字段。"""
        task.status = status
        task.updated_at = _now()
        if status == PROCESSING:
            pass
        if error:
            task.error = error
        task_total = task.blog_images + task.web_images
        if task_total > 0:
            task.total_images = task_total
        return self.update(task)

    def _read_raw_rows(self) -> list[list]:
        result = (
            self._client.spreadsheets()
            .values()
            .get(spreadsheetId=self._spreadsheet_id, range=self._range)
            .execute()
        )
        return result.get("values", [])

    def close(self) -> None:
        # HTTP transport 由 google-api 管理；无额外资源需要释放
        self._service = None


def _task_to_row(task: Task, with_task_id: bool) -> list:
    task_id = task.task_id or ""
    if with_task_id and not task_id:
        task_id = f"cf_{datetime.now().strftime('%Y%m%d')}_{abs(hash(task.url)) % 1000:03d}"
    row = [
        str(task_id),
        str(task.title),
        str(task.url),
        str(task.published_at),
        str(task.status),
        str(task.blog_images),
        str(task.web_images),
        str(task.total_images),
        str(task.local_path),
        str(task.created_at),
        str(task.updated_at),
        str(task.error),
    ]
    return row