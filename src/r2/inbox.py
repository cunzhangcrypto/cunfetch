"""R2 收件箱拉取编排。

pull_inbox(settings, slot)：
  - slot ∈ auto|early|mid|late|all
  - 构造前缀 inbox/<today>/<slot>/，增量下载到本地 inbox 目录
  - 落盘后上报 feedback 到 Cloudflare Worker（看板显示"已下载"）
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from .client import R2Client
from .records import PullRecords
from ..storage.r2local import target_dir_for, write_info_json, now_iso

logger = logging.getLogger("cunfetch.r2.inbox")

SLOTS = ("early", "mid", "late")


def resolve_slots(slot: str) -> list[str]:
    slot = (slot or "auto").lower()
    if slot == "all":
        return list(SLOTS)
    if slot in SLOTS:
        return [slot]
    # auto：按当前时刻判定落在哪个取件窗口（08:30/11:35/18:35 附近）
    now = datetime.now()
    minute = now.hour * 60 + now.minute
    if minute <= 510:        # <= 08:30
        return ["early"]
    if minute <= 695:        # <= 11:35
        return ["mid"]
    if minute <= 1115:       # <= 18:35
        return ["late"]
    return ["late"]


def _today_cn() -> str:
    return datetime.now().strftime("%Y%m%d")


def _send_feedback(settings, date: str, slot: str, slug: str, size: int) -> bool:
    """上报本地下载成功到 Worker（供看板展示）。失败仅告警，不中断。"""
    base = (getattr(settings.r2, "worker_base_url", "") or "").strip()
    token = (getattr(settings.r2, "worker_token", "") or "").strip()
    if not base or not token:
        logger.info("未配置 worker_base_url/worker_token，跳过 feedback 上报")
        return False
    try:
        from ..netutil import make_session
        from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential
        import requests

        session = make_session(settings)
        url = base.rstrip("/") + "/api/feedback"

        @retry(
            retry=retry_if_exception_type((requests.Timeout, requests.ConnectionError, requests.exceptions.ProxyError)),
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=0.8, min=0.5, max=3),
        )
        def _do():
            resp = session.post(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={
                    "slug": slug,
                    "slot": slot,
                    "date": date,
                    "downloaded": True,
                    "pull_at": now_iso(),
                    "local_size": size,
                },
                timeout=20,
            )
            resp.raise_for_status()
            return resp

        _do()
        logger.info("feedback 上报成功: %s/%s/%s", date, slot, slug)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("feedback 上报失败(不影响落盘): %s", exc)
        return False


def pull_inbox(settings, slot: str = "auto") -> dict:
    """执行拉取，返回 {"downloaded": int, "slots": [...], "skipped": int}。"""
    client = R2Client(settings)
    today = _today_cn()
    prefix_root = client.prefix
    local_root = client.local_root
    records = PullRecords(local_root)

    slots = resolve_slots(slot)
    downloaded = 0
    skipped = 0
    missing_platforms = 0
    handled_slugs = {}

    for sname in slots:
        sub = f"{prefix_root}/{today}/{sname}/"
        try:
            objects = client.list_objects(sub)
        except Exception as exc:  # noqa: BLE001
            logger.error("拉取前缀失败 %s: %s", sub, exc)
            continue

        for obj in objects:
            key = obj["key"]
            parts = key.split("/")
            if len(parts) < 5:
                continue
            date = parts[1]
            slot_part = parts[2]
            slug = parts[3]
            fname = parts[4]
            if fname == "status.json":
                continue  # 状态文件是 Worker 写，本地不拉

            slug_key = f"{slug}:{date}:{slot_part}"
            dest_dir = target_dir_for(local_root, date, slot_part, slug)
            file_dest = dest_dir / fname

            remote = client.meta(key)
            if remote is None:
                continue
            etag, size = remote["etag"], remote["size"]
            if records.is_done(key, etag, size, file_dest):
                skipped += 1
                continue

            # 下载（两段式：.part 再原子 rename）
            part = file_dest.with_suffix(file_dest.suffix + ".part") if file_dest.suffix else file_dest.parent / (file_dest.name + ".part")
            client.download_to(part, key)
            part.replace(file_dest)

            # 汇总要落 info.json 与 feedback 的元数据（视频篇为准）
            handled_slugs.setdefault(slug_key, {"date": date, "slot": slot_part, "slug": slug, "files": [], "size": 0, "path": dest_dir})
            info = handled_slugs[slug_key]
            info["files"].append(fname)
            if fname == "video.mp4":
                info["size"] = size
                info["path"] = dest_dir

            records.record(key, file_dest, etag, size, extra={"date": date, "slot": slot_part, "slug": slug})
            downloaded += 1

        # 该档位下无 video.mp4 却只有 platforms.json 或反之 → 标记缺失
        for slug_key, info in handled_slugs.items():
            has_video = any(f == "video.mp4" for f in info["files"])
            has_pl = any(f == "platforms.json" for f in info["files"])
            if info["path"] is not None and info["path"].is_dir():
                write_info_json(
                    info["path"],
                    {
                        "slug": info["slug"],
                        "date": info["date"],
                        "slot": info["slot"],
                        "has_video": has_video,
                        "has_platforms": has_pl,
                        "pulled_at": now_iso(),
                    },
                )
                if not has_pl:
                    missing_platforms += 1
                    logger.warning("该篇缺 platforms.json: %s", slug_key)
                if has_video:
                    _send_feedback(settings, info["date"], info["slot"], info["slug"], info["size"])

    logger.info("拉取完成：新下载 %s，跳过 %s，缺 platforms %s", downloaded, skipped, missing_platforms)
    return {"downloaded": downloaded, "slots": slots, "skipped": skipped, "missing_platforms": missing_platforms}