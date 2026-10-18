"""媒体流转发：把 WebDAV 的 Range 请求透传给浏览器。

浏览器要能拖动进度条，服务端就必须正确实现 HTTP Range（206 / Content-Range / Accept-Ranges），
否则每次 seek 都会退化成整文件重传。
"""
from __future__ import annotations

import re
from typing import Any

from .config import MIME_BY_EXT, STREAM_CHUNK
from .webdav import WebDAVClient, WebDAVError, split_ext

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeSpec:
    __slots__ = ("start", "end", "unsatisfiable")

    def __init__(self, start: int | None, end: int | None, unsatisfiable: bool = False):
        self.start = start
        self.end = end
        self.unsatisfiable = unsatisfiable

    @property
    def header_value(self) -> str | None:
        if self.unsatisfiable or self.start is None or self.end is None:
            return None
        return f"bytes {self.start}-{self.end}"

    def content_range(self, total: int | None) -> str | None:
        if self.unsatisfiable or self.start is None:
            return None
        end = self.end if self.end is not None else (total - 1 if total else "*")
        return f"bytes {self.start}-{end}/" + (str(total) if total else "*")


def parse_range(value: str | None, total: int | None) -> RangeSpec | None:
    """解析 Range 头。返回 None 表示普通全量请求。"""
    if not value:
        return None
    m = _RANGE_RE.match(value.strip())
    if not m:
        return None
    raw_start, raw_end = m.group(1), m.group(2)
    if raw_start == "" and raw_end == "":
        return None
    if raw_start == "":  # bytes=-N → 末尾 N 字节
        if not total:
            return RangeSpec(None, None, unsatisfiable=True)
        n = int(raw_end)
        if n <= 0:
            return RangeSpec(None, None, unsatisfiable=True)
        start = max(0, total - n)
        return RangeSpec(start, total - 1)
    start = int(raw_start)
    end = int(raw_end) if raw_end else None
    if end is not None and end < start:
        return RangeSpec(None, None, unsatisfiable=True)
    if total is not None and start >= total:
        return RangeSpec(None, None, unsatisfiable=True)
    if total is not None and end is not None:
        end = min(end, total - 1)
    return RangeSpec(start, end)


def guess_mime(name: str, remote_mime: str = "") -> str:
    ext = split_ext(name)
    return remote_mime or MIME_BY_EXT.get(ext) or "application/octet-stream"


def open_media_stream(client: WebDAVClient, remote_path: str, name: str,
                      range_header: str | None, mime: str = "",
                      timeout: int = 60):
    """打开远端媒体。返回 (响应, 状态码, 响应头 dict, 需要回写给浏览器的头)。

    有些 WebDAV 服务器忽略 Range 直接返回 200 全量 —— 这里检测到就记录 total，
    由调用方裁剪，保证语义正确。
    """
    upstream_range = range_header
    resp, head = client.stream(remote_path, upstream_range, timeout=timeout)
    status = resp.status if hasattr(resp, "status") else 200
    total = None
    if head.get("content-range"):
        cr = head["content-range"]
        if "/" in cr:
            tail = cr.rsplit("/", 1)[1].strip()
            if tail.isdigit():
                total = int(tail)
    if not total and head.get("content-length"):
        try:
            total = int(head["content-length"])
        except ValueError:
            total = None

    spec = parse_range(range_header, total) if range_header else None

    # 服务器无视 Range：自己按字节裁剪
    if range_header and spec and not spec.unsatisfiable and status == 200:
        # 注意：urllib 的 HTTPResponse 确实有 seek 方法，但会抛
        # io.UnsupportedOperation（它只是占位），所以不能靠 hasattr 判断。
        seek_ok = False
        seek = getattr(resp, "seek", None)
        if callable(seek) and getattr(resp, "seekable", lambda: False)():
            try:
                seek(spec.start)
                seek_ok = True
            except (OSError, ValueError):
                seek_ok = False
        if not seek_ok:
            # 读掉前缀再继续
            remaining = spec.start
            while remaining > 0:
                chunk = resp.read(min(STREAM_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)

    out_headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Content-Type": guess_mime(name, mime),
        "Cache-Control": "no-store",
    }
    if total is not None:
        out_headers["X-Total-Size"] = str(total)

    if spec and spec.unsatisfiable:
        out_headers["Content-Range"] = f"bytes */{total or 0}"
        return resp, 416, out_headers, None

    if spec and not spec.unsatisfiable:
        out_headers["Content-Range"] = spec.content_range(total) or ""
        content_length = None
        if spec.end is not None:
            content_length = spec.end - spec.start + 1
        elif total is not None:
            content_length = total - spec.start
        if content_length is not None:
            out_headers["Content-Length"] = str(content_length)
        return resp, 206, out_headers, None

    # 全量
    if head.get("content-type") and "text/html" in head["content-type"].lower():
        out_headers["Content-Type"] = guess_mime(name, mime)
    if total is not None:
        out_headers["Content-Length"] = str(total)
    return resp, 200, out_headers, None


def iter_chunks(resp: Any, limit: int | None = None) -> Any:
    """按块读取上游响应，limit 为剩余字节数（用于 Range 裁剪）。"""
    if limit is None:
        while True:
            chunk = resp.read(STREAM_CHUNK)
            if not chunk:
                return
            yield chunk
    else:
        remaining = limit
        while remaining > 0:
            chunk = resp.read(min(STREAM_CHUNK, remaining))
            if not chunk:
                return
            remaining -= len(chunk)
            yield chunk
