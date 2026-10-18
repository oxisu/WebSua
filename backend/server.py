"""HTTP 服务：REST API + 静态资源 + 媒体流。基于标准库 ThreadingHTTPServer。"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import socketserver
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from . import db, scanner
from .config import FRONTEND_DIR
from .stream import WebDAVError, guess_mime, iter_chunks, open_media_stream, parse_range
from .webdav import WebDAVClient, make_client

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")


class Route:
    __slots__ = ("method", "regex", "handler", "raw_body")

    def __init__(self, method: str, pattern: str, handler: Callable, raw_body: bool = False):
        self.method = method
        self.regex = re.compile("^" + pattern + "$")
        self.handler = handler
        self.raw_body = raw_body


class Ctx:
    """一次请求的上下文。"""

    def __init__(self, handler: "AppHandler", method: str, path: str,
                 query: dict[str, list[str]], params: dict[str, str],
                 body: bytes, client_ip: str):
        self.h = handler
        self.method = method
        self.path = path
        self.query = query
        self.params = params
        self.body = body
        self.client_ip = client_ip
        self._sent = False

    def q(self, key: str, default: str = "") -> str:
        v = self.query.get(key)
        return v[0] if v else default

    def q_int(self, key: str, default: int) -> int:
        try:
            return int(self.q(key, "") or default)
        except ValueError:
            return default

    def q_list(self, key: str) -> list[str]:
        out: list[str] = []
        for v in self.query.get(key, []):
            out.extend(x for x in v.split(",") if x)
        return out

    def json(self) -> dict[str, Any]:
        if not self.body:
            return {}
        try:
            data = json.loads(self.body.decode("utf-8"))
            return data if isinstance(data, dict) else {"value": data}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def send_json(self, data: Any, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.h.send_response(status)
        self.h.send_header("Content-Type", "application/json; charset=utf-8")
        self.h.send_header("Content-Length", str(len(payload)))
        self.h.send_header("Cache-Control", "no-store")
        self.h.end_headers()
        if self.h.command != "HEAD":
            self.h.wfile.write(payload)
        self._sent = True

    def ok(self, **kw: Any) -> None:
        self.send_json({"ok": True, **kw})

    def fail(self, message: str, status: int = 400, **kw: Any) -> None:
        self.send_json({"ok": False, "error": message, **kw}, status)

    def send_bytes(self, data: bytes, content_type: str, status: int = 200,
                   extra: dict[str, str] | None = None) -> None:
        self.h.send_response(status)
        self.h.send_header("Content-Type", content_type)
        self.h.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.h.send_header(k, v)
        self.h.end_headers()
        if self.h.command != "HEAD":
            self.h.wfile.write(data)
        self._sent = True


class AppHandler(BaseHTTPRequestHandler):
    server_version = "WebSua/1.0"
    protocol_version = "HTTP/1.1"
    routes: list[Route] = []

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("WEBSUA_VERBOSE"):
            print(f"[http] {self.address_string()} {fmt % args}")

    def _safe_fail(self, ctx: Ctx, msg: str, status: int) -> None:
        """发错误响应；客户端已断开时写响应会再抛 OSError，静默。"""
        try:
            ctx.fail(msg, status)
        except OSError:
            pass

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

        for route in self.routes:
            if route.method != method:
                continue
            m = route.regex.match(path)
            if not m:
                continue
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            ctx = Ctx(self, method, path, query, m.groupdict(), body,
                      self.client_address[0])
            try:
                route.handler(ctx)
            except WebDAVError as e:
                if not ctx._sent:
                    self._safe_fail(ctx, str(e), 502)
            except (BrokenPipeError, ConnectionResetError,
                    ConnectionAbortedError, TimeoutError):
                # 浏览器断开连接（切视频/拖进度条/暂停/关页面）是正常现象，
                # Windows 上映射为 WinError 10053/10054，静默即可
                pass
            except Exception as e:  # noqa: BLE001
                if not ctx._sent:
                    self._safe_fail(ctx, f"服务器内部错误：{e}", 500)
            return

        if path.startswith("/api/"):
            self.send_response(404)
            payload = json.dumps({"ok": False, "error": "接口不存在"},
                                 ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self._serve_static(path)

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Range")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    # ---------- 静态资源 ----------

    def _serve_static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        # 目录穿越防护
        try:
            target = (FRONTEND_DIR / path.lstrip("/")).resolve()
            root = FRONTEND_DIR.resolve()
        except (OSError, ValueError):
            self.send_error(400)
            return
        if not str(target).startswith(str(root)) or not target.is_file():
            # 前端是单页应用，未知路径回退到 index.html
            target = FRONTEND_DIR / "index.html"
            if not target.is_file():
                self.send_error(404)
                return
        ctype, _ = mimetypes.guess_type(str(target))
        data = target.read_bytes()
        etag = f'W/"{target.stat().st_mtime_ns}-{len(data)}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


# ============================================================ 路由实现

def normalize_url(raw: str) -> str:
    """补全协议头。只在明确没有协议、或写了内网地址时补 http。"""
    u = (raw or "").strip().rstrip("/")
    if not u:
        return u
    if u.lower().startswith(("http://", "https://")):
        return u
    # 本机 / 内网地址优先 http，避免自签名证书问题
    host = u.split("/")[0].split(":")[0]
    is_local = (
        host in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
        or host.startswith(("192.168.", "10.", "172.16.", "172.17.", "172.18.",
                            "172.19.", "172.2", "172.30.", "172.31."))
        or host.endswith((".local", ".lan", ".internal", ".home"))
    )
    return ("http://" if is_local else "https://") + u


def public_source(s: dict[str, Any]) -> dict[str, Any]:
    """去掉密码等敏感字段。"""
    return {k: v for k, v in s.items() if k != "password"}


def media_dto(m: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": m["id"], "name": m["name"], "kind": m.get("kind"),
        "ext": m.get("ext"), "size": m.get("size"), "mtime": m.get("mtime"),
        "folder": m.get("folder", ""), "duration": m.get("duration"),
        "width": m.get("width"), "height": m.get("height"),
        "source_id": m["source_id"], "source_name": m.get("source_name"),
        "source_color": m.get("source_color"),
        "position": m.get("position"), "finished": m.get("finished"),
        "is_fav": bool(m.get("is_fav")),
        "stream": f"/api/stream/{m['id']}",
        "fallback": f"/api/proxy/{m['id']}",
        "info": f"/api/media/{m['id']}",
        # TG 导出封面（同目录同名图片），存在才有值
        "poster": (f"/api/poster/{m['id']}" if m.get("poster_path") else None),
        # 同目录同名字幕（.srt/.vtt），存在才有值
        "subtitle": (f"/api/subtitle/{m['id']}" if m.get("subtitle_path") else None),
    }


def route(method: str, pattern: str) -> Callable:
    def deco(fn: Callable) -> Callable:
        AppHandler.routes.append(Route(method, pattern, fn))
        return fn
    return deco


# ---------- 系统 ----------

@route("GET", r"/api/health")
def health(c: Ctx) -> None:
    c.ok(now=int(time.time()))


@route("GET", r"/api/stats")
def api_stats(c: Ctx) -> None:
    s = db.stats()
    s["total_size_h"] = human_size(s["total_size"])
    s["scanning"] = [t for t in scanner.list_tasks() if t["state"] in ("pending", "running")]
    s["latest_task"] = scanner.list_tasks()[0] if scanner.list_tasks() else None
    c.ok(stats=s, sources=[public_source(x) for x in db.list_sources()])


def human_size(n: int | float | None) -> str:
    v = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if v < 1024 or unit == "TB":
            return f"{v:.0f} {unit}" if unit == "B" else f"{v:.1f} {unit}"
        v /= 1024
    return "0 B"


# ---------- 数据源 ----------

@route("GET", r"/api/sources")
def api_list_sources(c: Ctx) -> None:
    counts: dict[int, dict[str, int]] = {}
    for row in db.media_counts_by_source():
        entry = counts.setdefault(row["source_id"], {"all": 0, "size_total": 0})
        entry["all"] += row["c"]
        entry["size_total"] += int(row["total"] or 0)
        entry[row["kind"]] = row["c"]
    out = []
    for s in db.list_sources():
        d = public_source(s)
        d["counts"] = counts.get(s["id"], {"all": 0, "size_total": 0})
        d["has_password"] = bool(s.get("password"))
        d["scan_running"] = scanner.active_task_for(s["id"]) is not None
        out.append(d)
    c.ok(sources=out)


@route("POST", r"/api/sources")
def api_create_source(c: Ctx) -> None:
    d = c.json()
    if not d.get("name") or not d.get("base_url"):
        c.fail("名称和地址必填", 400)
        return
    base = normalize_url(str(d["base_url"]))
    if not base:
        c.fail("地址无效", 400)
        return
    d["base_url"] = base
    # 唯一性校验
    for s in db.list_sources():
        if s["base_url"].rstrip("/") == base.rstrip("/") and \
           (s.get("root_path") or "/") == (d.get("root_path") or "/"):
            c.fail("已存在地址与根路径相同的数据源", 409)
            return
    sid = db.create_source(d)
    c.ok(id=sid, source=public_source(db.get_source(sid) or {}))


@route("PUT", r"/api/sources/(?P<sid>\d+)")
def api_update_source(c: Ctx) -> None:
    sid = int(c.params["sid"])
    if not db.get_source(sid):
        c.fail("数据源不存在", 404)
        return
    d = c.json()
    # 前端不回传密码时保留原密码
    if "password" in d and not d.get("password") and d.get("has_password"):
        d.pop("password")
    d.pop("has_password", None)
    if "base_url" in d and d["base_url"]:
        d["base_url"] = normalize_url(str(d["base_url"]))
    db.update_source(sid, d)
    c.ok(source=public_source(db.get_source(sid) or {}))


@route("DELETE", r"/api/sources/(?P<sid>\d+)")
def api_delete_source(c: Ctx) -> None:
    sid = int(c.params["sid"])
    if db.delete_source(sid):
        c.ok()
    else:
        c.fail("数据源不存在", 404)


@route("POST", r"/api/sources/(?P<sid>\d+)/scan")
def api_scan_source(c: Ctx) -> None:
    sid = int(c.params["sid"])
    if not db.get_source(sid):
        c.fail("数据源不存在", 404)
        return
    task = scanner.start_scan(sid)
    c.ok(task=task)


@route("POST", r"/api/sources/(?P<sid>\d+)/scan/(?P<action>pause|resume|cancel)")
def api_scan_control(c: Ctx) -> None:
    """暂停 / 继续 / 取消扫描。"""
    sid = int(c.params["sid"])
    action = c.params["action"]
    if not db.get_source(sid):
        c.fail("数据源不存在", 404)
        return
    t = scanner.control_task(sid, action)
    if not t:
        c.fail("当前没有进行中的扫描任务", 409)
        return
    c.ok(task=t)


@route("POST", r"/api/sources/(?P<sid>\d+)/probe")
def api_probe_source(c: Ctx) -> None:
    """不落库地试探性连接：列出根目录前若干项。"""
    d = c.json() if c.body else {}
    if not d.get("base_url"):
        s = db.get_source(int(c.params["sid"]))
        d = s or {}
    base = normalize_url(str(d.get("base_url") or ""))
    if not base:
        c.fail("缺少地址", 400)
        return
    client = WebDAVClient(base, d.get("username") or "", d.get("password") or "",
                          verify_ssl=bool(d.get("verify_ssl", 1)), timeout=15)
    try:
        entries = client.list_dir(d.get("root_path") or "/")
    except WebDAVError as e:
        c.fail(str(e), 502)
        return
    folders = [e for e in entries if e["is_dir"]][:20]
    files = [e for e in entries if not e["is_dir"]][:20]
    c.ok(ok=True, folders=[f["name"] for f in folders],
         files=[{"name": f["name"], "size": f["size"], "kind": f["kind"]} for f in files],
         total=len(entries))


@route("GET", r"/api/tasks")
def api_tasks(c: Ctx) -> None:
    c.ok(tasks=scanner.list_tasks())


@route("GET", r"/api/tasks/(?P<tid>\d+)")
def api_task(c: Ctx) -> None:
    t = scanner.get_task(int(c.params["tid"]))
    if not t:
        c.fail("任务不存在", 404)
        return
    c.ok(task=t)


@route("GET", r"/api/scan-log")
def api_scan_log(c: Ctx) -> None:
    """返回 data/scan.log 的内容（最多 200 行）。"""
    limit = max(1, min(500, c.q_int("limit", 200)))
    try:
        from .config import SCAN_LOG_PATH
        if not SCAN_LOG_PATH.exists():
            c.ok(lines=[], file=str(SCAN_LOG_PATH))
            return
        with open(SCAN_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        c.ok(lines=[l.rstrip("\n") for l in lines[-limit:]],
             file=str(SCAN_LOG_PATH), total=len(lines))
    except OSError as e:
        c.fail(f"读取日志失败：{e}", 500)


# ---------- 媒体库 ----------

@route("GET", r"/api/media")
def api_media(c: Ctx) -> None:
    sids = [int(x) for x in c.q_list("sources") if x.isdigit()]
    kinds = c.q_list("kinds")
    limit = max(1, min(200, c.q_int("limit", 60)))
    offset = max(0, c.q_int("offset", 0))
    rows, total = db.query_media(
        source_ids=sids or None, kinds=kinds or None,
        folder=c.q("folder") or None, search=c.q("q") or None,
        order=c.q("order", "new"), limit=limit, offset=offset,
        favorite_only=c.q("fav") == "1",
    )
    c.ok(media=[media_dto(r) for r in rows], total=total, limit=limit, offset=offset)


@route("GET", r"/api/history")
def api_history(c: Ctx) -> None:
    """观看历史：有进度的媒体，按最近观看时间降序。"""
    sids = [int(x) for x in c.q_list("sources") if x.isdigit()]
    limit = max(1, min(200, c.q_int("limit", 60)))
    offset = max(0, c.q_int("offset", 0))
    rows, total = db.query_history(limit=limit, offset=offset,
                                   source_ids=sids or None)
    out = []
    for r in rows:
        d = media_dto(r)
        d["position"] = r.get("position") or 0
        d["duration"] = r.get("p_duration") or r.get("duration") or 0
        d["watched_at"] = r.get("watched_at")
        d["finished"] = bool(r.get("finished"))
        out.append(d)
    c.ok(history=out, total=total, limit=limit, offset=offset)


@route("GET", r"/api/media/(?P<mid>\d+)")
def api_media_one(c: Ctx) -> None:
    """播放器「视频信息」面板用的接口。"""
    m = db.get_media(int(c.params["mid"]))
    if not m:
        c.fail("媒体不存在", 404)
        return
    prog = db.get_progress(m["id"])
    c.ok(
        id=m["id"], file_name=m["name"], name=m["name"], kind=m["kind"],
        file_size=m["size"], file_size_str=human_size(m["size"]),
        mtime=m["mtime"], folder=m.get("folder"),
        source_name=m.get("source_name"), source_id=m["source_id"],
        mime=m.get("mime"), ext=m.get("ext"),
        duration=m.get("duration"), width=m.get("width"), height=m.get("height"),
        codec=None, fps=None, bitrate=None,
        position=(prog or {}).get("position", 0),
        is_fav=db.is_favorite(m["id"]),
    )


@route("POST", r"/api/media/(?P<mid>\d+)/fav")
def api_toggle_fav(c: Ctx) -> None:
    mid = int(c.params["mid"])
    if not db.get_media(mid):
        c.fail("媒体不存在", 404)
        return
    c.ok(favorite=db.toggle_favorite(mid))


@route("GET", r"/api/folders")
def api_folders(c: Ctx) -> None:
    sids = [int(x) for x in c.q_list("sources") if x.isdigit()]
    sources = db.list_sources()
    out = []
    for s in sources:
        if sids and s["id"] not in sids:
            continue
        out.append({"source_id": s["id"], "source_name": s["name"],
                    "folders": db.list_folders(s["id"])})
    c.ok(sources=out)


@route("GET", r"/api/progress")
def api_progress(c: Ctx) -> None:
    c.ok(progress=db.all_progress(0.5))


@route("POST", r"/api/progress")
def api_save_progress(c: Ctx) -> None:
    d = c.json()
    try:
        mid = int(d.get("media_id"))
        pos = float(d.get("position") or 0)
        dur = float(d.get("duration") or 0)
    except (TypeError, ValueError):
        c.fail("参数错误", 400)
        return
    if pos <= 0:
        db.clear_progress(mid)
    else:
        db.save_progress(mid, pos, dur)
    c.ok()


@route("POST", r"/api/progress-batch")
def api_save_progress_batch(c: Ctx) -> None:
    """页面卸载时用 sendBeacon 一次上报多条，避免逐条请求被浏览器取消。"""
    d = c.json()
    entries = d.get("entries") or []
    n = 0
    for e in entries:
        try:
            mid = int(e.get("media_id"))
            pos = float(e.get("position") or 0)
            dur = float(e.get("duration") or 0)
        except (TypeError, ValueError):
            continue
        if mid <= 0:
            continue
        if pos <= 0:
            db.clear_progress(mid)
        else:
            db.save_progress(mid, pos, dur)
        n += 1
    c.ok(saved=n)


@route("DELETE", r"/api/progress")
def api_clear_progress(c: Ctx) -> None:
    n = db.clear_all_progress()
    c.ok(cleared=n)


# ---------- 播放队列 ----------

QUEUE_MAX_IDS = 2000          # 单个队列上限，防异常payload把 meta 表撑爆
QUEUE_MODES = ("off", "all", "one")   # 循环：关 / 整表 / 单集


def _normalize_queue(d: Any) -> dict[str, Any] | None:
    """校验并归一化前端提交的队列状态；不合法返回 None（调用方回 400）。"""
    if not isinstance(d, dict):
        return None
    ids = d.get("ids")
    if not isinstance(ids, list):
        return None
    out: list[int] = []
    for x in ids:
        try:
            v = int(x)
        except (TypeError, ValueError):
            return None
        if v <= 0:
            return None
        out.append(v)
        if len(out) > QUEUE_MAX_IDS:
            return None
    mode = d.get("mode", "off")
    if mode not in QUEUE_MODES:
        mode = "off"
    try:
        index = int(d.get("index", -1))
    except (TypeError, ValueError):
        index = -1
    index = max(-1, min(index, len(out) - 1 if out else -1))
    return {
        "ids": out,
        "index": index,
        "mode": mode,
        "shuffle": bool(d.get("shuffle")),
        # enabled=false = 用户主动清空了队列，不要再自动生成
        "enabled": d.get("enabled", True) is not False,
        "origin": str(d.get("origin") or "")[:500],
        "saved_at": int(time.time()),
    }


@route("GET", r"/api/queue")
def api_get_queue(c: Ctx) -> None:
    """读取持久化的播放队列，并把 id 解析成当前存在的媒体。

    队列只存 id（媒体表会随扫描增减），解析阶段剔除已消失的条目，
    前端拿到的直接就是可渲染的完整列表。
    """
    saved = db.get_setting("play_queue") or {}
    if not isinstance(saved, dict):
        saved = {}
    raw = saved.get("ids") or []
    ids: list[int] = []
    for x in raw:
        try:
            v = int(x)
        except (TypeError, ValueError):
            continue
        if v > 0:
            ids.append(v)
    # 停用源的内容不进队列（与 /api/media 的可见性保持一致）
    rows = [r for r in db.get_media_many(ids) if r.get("source_enabled")]
    if len(rows) != len(ids):
        # 有条目失效：顺手写回裁剪后的列表，避免 meta 里堆积死 id
        db.set_setting("play_queue", {**saved, "ids": [r["id"] for r in rows]})
    mode = saved.get("mode") if saved.get("mode") in QUEUE_MODES else "off"
    try:
        index = int(saved.get("index", -1))
    except (TypeError, ValueError):
        index = -1
    index = max(-1, min(index, len(rows) - 1 if rows else -1))
    c.ok(queue={
        "ids": [r["id"] for r in rows],
        "index": index,
        "mode": mode,
        "shuffle": bool(saved.get("shuffle")),
        "enabled": saved.get("enabled", True) is not False,
        "origin": str(saved.get("origin") or ""),
        "items": [media_dto(r) for r in rows],
    })


@route("POST", r"/api/queue")
def api_set_queue(c: Ctx) -> None:
    q = _normalize_queue(c.json())
    if q is None:
        c.fail("队列数据不合法", 400)
        return
    db.set_setting("play_queue", q)
    c.ok()


@route("DELETE", r"/api/queue")
def api_clear_queue(c: Ctx) -> None:
    db.set_setting("play_queue", {
        "ids": [], "index": -1, "mode": "off",
        "shuffle": False, "enabled": True, "origin": "",
    })
    c.ok()


# ---------- 媒体流 ----------

def _client_for_media(m: dict[str, Any]) -> WebDAVClient:
    return WebDAVClient(m["base_url"], m.get("username") or "", m.get("password") or "",
                        verify_ssl=bool(m.get("verify_ssl", 1)), timeout=60)


@route("GET", r"/api/stream/(?P<mid>\d+)")
def api_stream(c: Ctx) -> None:
    mid = int(c.params["mid"])
    m = db.get_media(mid)
    if not m:
        c.fail("媒体不存在", 404)
        return

    inline = c.q("dl") != "1"
    range_header = c.h.headers.get("Range")

    # 越界的 Range（416）用本地已知大小判定，不去打扰远端 ——
    # 各家服务器对越界的响应不一致（有的 416，有的干脆回 200 全量）
    total_hint = m.get("size") or None
    pre = parse_range(range_header, total_hint) if range_header else None
    if pre and pre.unsatisfiable:
        c.h.send_response(416)
        c.h.send_header("Content-Range", f"bytes */{total_hint or 0}")
        c.h.send_header("Accept-Ranges", "bytes")
        c.h.send_header("Content-Length", "0")
        c.h.end_headers()
        c._sent = True
        return

    # 探测失败时返回 JSON 错误体 —— 播放器 probeMediaFailure 依赖这个拿到中文原因
    try:
        client = _client_for_media(m)
        resp, status, headers, _ = open_media_stream(
            client, m["remote_path"], m["name"],
            range_header, mime=m.get("mime") or "",
        )
    except WebDAVError as e:
        reason = f"远端读取失败：{e}"
        if "401" in str(e) or "403" in str(e):
            reason = "WebDAV 认证失败（账号或密码不对）"
        elif "404" in str(e):
            reason = "远端文件已被删除或移动"
        elif "连接失败" in str(e):
            reason = "无法连接 WebDAV 服务器"
        # 服务端留痕：123 等网盘的兼容性问题靠这条日志定位（路径/源/远端状态码）
        scanner.scan_log("error", m["source_id"],
                         f"播放失败 [{m['name']}] path={m['remote_path']!r} {e}")
        c.send_json({"ok": False, "error": reason, "name": m["name"]}, 502)
        return

    if not inline:
        headers["Content-Disposition"] = f'attachment; filename*=UTF-8\'\'{urllib.parse.quote(m["name"])}'

    c.h.send_response(status)
    for k, v in headers.items():
        if v:
            c.h.send_header(k, v)
    c.h.end_headers()
    c._sent = True
    if c.h.command == "HEAD":
        resp.close()
        return

    limit = None
    cr = headers.get("Content-Range")
    if cr and "/" in cr:
        rng = parse_range(cr.split(" ", 1)[1] if " " in cr else cr, None)
        if rng and rng.end is not None and rng.start is not None:
            limit = rng.end - rng.start + 1
    try:
        for chunk in iter_chunks(resp, limit):
            c.h.wfile.write(chunk)
    finally:
        resp.close()


@route("GET", r"/api/proxy/(?P<mid>\d+)")
def api_proxy(c: Ctx) -> None:
    """备用端点：不做任何裁剪的直读，用于主端点失效时回退。"""
    mid = int(c.params["mid"])
    m = db.get_media(mid)
    if not m:
        c.fail("媒体不存在", 404)
        return
    try:
        client = _client_for_media(m)
        resp, head = client.stream(m["remote_path"], None, timeout=90)
    except WebDAVError as e:
        c.send_json({"ok": False, "error": f"备用端点读取失败：{e}"}, 502)
        return
    ctype = guess_mime(m["name"], m.get("mime") or "")
    c.h.send_response(200)
    c.h.send_header("Content-Type", ctype)
    if head.get("content-length"):
        c.h.send_header("Content-Length", head["content-length"])
    c.h.send_header("Accept-Ranges", "bytes")
    c.h.send_header("Cache-Control", "no-store")
    c.h.end_headers()
    c._sent = True
    try:
        for chunk in iter_chunks(resp):
            c.h.wfile.write(chunk)
    finally:
        resp.close()


# ---------- 设置 ----------

@route("GET", r"/api/poster/(?P<mid>\d+)")
def api_poster(c: Ctx) -> None:
    """TG 导出的同名封面图。无封面时 404，前端回退到视频截帧。"""
    mid = int(c.params["mid"])
    m = db.get_media(mid)
    if not m:
        c.fail("媒体不存在", 404)
        return
    poster = m.get("poster_path") or ""
    if not poster:
        c.fail("无封面", 404)
        return
    try:
        client = _client_for_media(m)
        resp, head = client.stream(poster, None, timeout=30)
    except WebDAVError as e:
        c.send_json({"ok": False, "error": f"封面读取失败：{e}"}, 502)
        return
    c.h.send_response(200)
    c.h.send_header("Content-Type", guess_mime(poster, "image/jpeg"))
    if head.get("content-length"):
        c.h.send_header("Content-Length", head["content-length"])
    c.h.send_header("Cache-Control", "max-age=3600")
    c.h.end_headers()
    c._sent = True
    try:
        for chunk in iter_chunks(resp):
            c.h.wfile.write(chunk)
    finally:
        resp.close()


@route("GET", r"/api/subtitle/(?P<mid>\d+)")
def api_subtitle(c: Ctx) -> None:
    """同目录同名字幕（.srt / .vtt）。无字幕时 404，前端据此回退。

    按**原文**返回，不做格式转换：SRT→VTT 在前端完成，
    后端因此保持零第三方依赖。
    """
    mid = int(c.params["mid"])
    m = db.get_media(mid)
    if not m:
        c.fail("媒体不存在", 404)
        return
    sub = m.get("subtitle_path") or ""
    if not sub:
        c.fail("无字幕", 404)
        return
    try:
        client = _client_for_media(m)
        resp, head = client.stream(sub, None, timeout=30)
    except WebDAVError as e:
        c.send_json({"ok": False, "error": f"字幕读取失败：{e}"}, 502)
        return
    ctype = ("text/vtt; charset=utf-8" if sub.lower().endswith(".vtt")
             else "application/x-subrip; charset=utf-8")
    c.h.send_response(200)
    c.h.send_header("Content-Type", ctype)
    if head.get("content-length"):
        c.h.send_header("Content-Length", head["content-length"])
    c.h.send_header("Cache-Control", "max-age=3600")
    c.h.end_headers()
    c._sent = True
    try:
        for chunk in iter_chunks(resp):
            c.h.wfile.write(chunk)
    finally:
        resp.close()


@route("GET", r"/api/settings")
def api_get_settings(c: Ctx) -> None:
    c.ok(settings=db.get_setting("app", {}))


@route("POST", r"/api/settings")
def api_set_settings(c: Ctx) -> None:
    db.set_setting("app", c.json())
    c.ok()


@route("POST", r"/api/seed-demo")
def api_seed_demo(c: Ctx) -> None:
    """写入一个示例（无远端）数据源，便于查看界面。"""
    existing = [s for s in db.list_sources() if s["base_url"] == "demo://local"]
    if existing:
        c.ok(id=existing[0]["id"])
        return
    sid = db.create_source({
        "name": "示例源", "base_url": "demo://local", "root_path": "/",
        "kind": "video", "icon": "", "color": "#6C8CFF", "sort": 0,
    })
    c.ok(id=sid)


# ============================================================ 启动

class ThreadedServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def handle_error(self, request, client_address) -> None:
        """兜底静默：客户端断开（切视频/关页面）在 Windows 上抛
        ConnectionAbortedError(10053)/ConnectionResetError(10054)，
        属于正常现象，不值得打印整个堆栈刷屏。其余错误照常输出。"""
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError,
                            ConnectionAbortedError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve(host: str = "127.0.0.1", port: int = 8770) -> ThreadedServer:
    httpd = ThreadedServer((host, port), AppHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    scanner.start_auto_scans()
    return httpd
