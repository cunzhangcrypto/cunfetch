"""R2 S3 兼容客户端：列对象、取元信息、断点下载。

使用 boto3 访问 Cloudflare R2（S3 兼容 API）。
凭据/endpoint 从 settings.r2 读取；代理在调用前由 netutil.ensure_proxy_env 注入环境变量。
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("cunfetch.r2client")

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError as BotoClientError
except Exception as exc:  # noqa: BLE001
    boto3 = None
    Config = None
    BotoClientError = Exception
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


class R2Error(RuntimeError):
    """R2 访问失败。"""


class R2Client:
    def __init__(self, settings):
        if boto3 is None:
            raise R2Error(f"缺少 boto3 依赖（国产 C:\\Python314 请 pip install boto3）: {_IMPORT_ERROR}")
        r2 = settings.r2
        account_id = (r2.account_id or "").strip()
        endpoint = (r2.endpoint or "").strip()
        if endpoint:
            endpoint = endpoint.rstrip("/")
        elif account_id:
            endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
        else:
            raise R2Error("未配置 r2.endpoint 或 r2.account_id")
        bucket = (r2.bucket or "cunfetch-inbox").strip()
        self.bucket = bucket
        self.prefix = (r2.prefix or "inbox").strip("/")
        self.local_root = Path(r2.local_root or (settings.storage.root + "/inbox")).resolve()

        kwargs = {
            "service_name": "s3",
            "endpoint_url": endpoint,
            "region_name": (r2.region or "auto").strip(),
            "config": Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        }
        ak = r2.access_key_id or ""
        sk = r2.secret_access_key or ""
        if ak and sk:
            kwargs["aws_access_key_id"] = ak
            kwargs["aws_secret_access_key"] = sk
        self.client = boto3.client(**kwargs)

    def list_objects(self, prefix: str) -> list[dict]:
        """返回前缀下对象元信息列表 [{key, size, etag}]。"""
        paginator = self.client.get_paginator("list_objects_v2")
        out = []
        try:
            for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    out.append({"key": obj["Key"], "size": obj.get("Size", 0), "etag": obj.get("ETag", "")})
        except BotoClientError as exc:
            raise R2Error(f"R2 列对象失败: {exc}") from exc
        return out

    def meta(self, key: str) -> dict | None:
        """返回对象的 size/etag；不存在返回 None。"""
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
            return {"key": key, "size": head.get("ContentLength", 0), "etag": head.get("ETag", "")}
        except BotoClientError as exc:
            code = str(getattr(exc, "response", {}) or "").lower()
            if "404" in str(exc) or "notfound" in str(exc) or "not found" in str(exc):
                return None
            raise R2Error(f"R2 head 失败 {key}: {exc}") from exc

    def download_to(self, dest: Path | str, key: str) -> tuple[str, int]:
        """下载对象到 dest（覆盖）。返回 (etag, size)。断点/重试由 boto3 处理。"""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=key)
            etag = obj.get("ETag", "")
            meta_size = obj.get("ContentLength", 0)
            # 分块流式写盘，避免大视频一次性进内存
            with dest.open("wb") as fh:
                for chunk in obj["Body"].iter_chunks(chunk_size=1024 * 1024):
                    fh.write(chunk)
            return etag, meta_size
        except BotoClientError as exc:
            raise R2Error(f"R2 下载失败 {key}: {exc}") from exc