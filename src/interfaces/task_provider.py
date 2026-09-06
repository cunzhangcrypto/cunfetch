"""核心业务逻辑与任务队列解耦的接口层。

第一阶段实现 GoogleSheetsProvider；
未来 CunWork 完成后实现 CunWorkProvider，二者都继承 TaskProvider，
因此 CunFetch 核心逻辑无需改动。
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

# 任务状态，见需求第十三节
PENDING = "pending"
PROCESSING = "processing"
COMPLETED = "completed"
FAILED = "failed"


@dataclass
class Task:
    """一条采集任务，字段对应 Google Sheets「CunFetch Tasks」表。"""

    task_id: str = ""
    title: str = ""
    url: str = ""
    published_at: str = ""      # ISO 时间字符串
    status: str = PENDING
    blog_images: int = 0
    web_images: int = 0
    total_images: int = 0
    local_path: str = ""
    created_at: str = ""
    updated_at: str = ""
    error: str = ""

    @classmethod
    def new(cls, url: str, title: str = "", published_at: str = "") -> "Task":
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        return cls(
            url=url,
            title=title,
            published_at=published_at,
            status=PENDING,
            created_at=now,
            updated_at=now,
        )


class TaskProvider(abc.ABC):
    """任务队列抽象。

    队列实现负责：
      - create(task): 新建任务（按 url 去重，重复返回 False）
      - get_pending_tasks(): 拉取所有 pending 任务
      - get_task(url): 查询某个 url 的任务（用于幂等判断）
      - update(task): 更新任务状态与结果字段
    """

    @abc.abstractmethod
    def create(self, task: Task) -> bool:
        """插入任务。若 url 已存在则返回 False（幂等）。"""

    @abc.abstractmethod
    def get_pending_tasks(self) -> list[Task]:
        """返回所有 status == pending 的任务。"""

    @abc.abstractmethod
    def get_task(self, url: str) -> Optional[Task]:
        """按 url 查询任务，不存在返回 None。"""

    @abc.abstractmethod
    def update(self, task: Task) -> bool:
        """更新任务状态与结果字段。"""