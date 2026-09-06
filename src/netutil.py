"""轻量网络请求工具：统一 timeout、随 User-Agent、带重试。

所有网络请求都必须设置超时，禁止无限等待（需求原则 9）。
下载失败自动重试（原则 10）。
"""
from __future__ import annotations

import os
import time

import requests
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

_RETRYABLE = (
    requests.Timeout,
    requests.ConnectionError,
    requests.exceptions.ProxyError,
    requests.exceptions.ChunkedEncodingError,
)


def _proxy_url(settings) -> str:
    """读取配置的代理地址，带简单的默认端口推断。"""
    proxy = str(getattr(settings.network, "proxy", "") or "").strip()
    if not proxy:
        return ""
    proxy = proxy.replace("socks5://", "socks5h://")
    return proxy


def apply_requests_proxy(session: requests.Session, settings) -> None:
    """把配置的代理应用到 requests 会话。未配置则不改变（trust_env 保持默认）。"""
    url = _proxy_url(settings)
    if url:
        session.proxies.update({"http": url, "https": url})


def ensure_proxy_env(settings) -> None:
    """把配置的代理同步到环境变量，供 googleapiclient 内部传输读取（直连 Google 通常不可达）。"""
    url = _proxy_url(settings)
    if not url:
        return
    if os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy"):
        return
    os.environ.setdefault("HTTP_PROXY", url)
    os.environ.setdefault("HTTPS_PROXY", url)


def make_session(settings) -> requests.Session:
    sess = requests.Session()
    sess.headers.update(
        {
            "User-Agent": settings.network.user_agent,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }
    )
    apply_requests_proxy(sess, settings)
    return sess


def get_with_retry(
    session: requests.Session,
    url: str,
    settings,
    timeout: float | None = None,
    retries: int | None = None,
    stream: bool = False,
) -> requests.Response:
    """带重试的 GET。返回已就绪的 Response（调用方负责 close）。"""
    tout = timeout if timeout is not None else float(settings.network.timeout_seconds)
    attempts = retries if retries is not None else int(settings.images.download_retries or 3)

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(attempts),
        wait=wait_exponential(multiplier=0.8, min=0.5, max=4),
        reraise=True,
    )
    def _do() -> requests.Response:
        resp = session.get(url, timeout=tout, stream=stream)
        return resp

    return _do()


def safe_sleep(seconds: float) -> None:
    time.sleep(seconds)


# 简单头部探测，用于判断资源类型，不做完整下载
def probe_headers(session: requests.Session, url: str, settings, timeout: float | None = None) -> dict | None:
    tout = timeout if timeout is not None else float(settings.network.timeout_seconds)
    try:
        resp = session.head(url, timeout=tout, allow_redirects=True)
        return {"content_type": resp.headers.get("Content-Type", ""), "content_length": resp.headers.get("Content-Length", ""), "status": resp.status_code}
    except requests.RequestException:
        return None