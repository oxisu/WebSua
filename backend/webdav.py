"""WebDAV 客户端：目录列举（PROPFIND）与文件流读取（GET + Range）。

纯标准库实现，无需第三方依赖。
"""
from __future__ import annotations

import base64
import http.client
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Iterator

from .config import (
    KIND_BY_EXT, MIME_BY_EXT, SKIP_DIRS, STREAM_CHUNK,
    SCAN_RATE_LIMIT, SCAN_RETRIES, SCAN_RETRY_BACKOFF, SCAN_429_EXTRA_WAIT,
)

DAV_NS = "DAV:"
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


class WebDAVError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def _ssl_ctx(verify: bool) -> ssl.SSLContext:
    if verify:
        return ssl.create_default_context()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _basic_auth(user: str, password: str) -> str:
    raw = f"{user}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def join_url(base: str, path: str) -> str:
    """把 base 与远程路径拼成完整 URL，并对中文等字符做百分号编码。"""
    if not path:
        path = "/"
    if not path.startswith("/"):
        path = "/" + path
    return base.rstrip("/") + urllib.parse.quote(path, safe="/~!$&'()*+,;=:@")


def split_ext(name: str) -> str:
    _, dot, ext = name.rpartition(".")
    return ("." + ext).lower() if dot else ""


def parse_http_date(value: str | None) -> int | None:
    """RFC 1123 / 850 / asctime 三种格式都覆盖。"""
    if not value:
        return None
    for fmt in ("%a, %d %b %Y %H:%M:%S GMT", "%A, %d-%b-%y %H:%M:%S GMT",
                "%a %b %d %H:%M:%S %Y"):
        try:
            import calendar
            return int(calendar.timegm(time.strptime(value.strip(), fmt)))
        except (ValueError, OverflowError):
            continue
    return None


class WebDAVClient:
    def __init__(self, base_url: str, username: str = "", password: str = "",
                 verify_ssl: bool = True, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.username = username or ""
        self.password = password or ""
        self.verify_ssl = verify_ssl
        self.timeout = timeout
        self._exclude: set[str] = set()
        self._opener = self._build_opener()
        self._last_request_at = 0.0   # 限流节拍
        self._rate_lock = threading.Lock()

    def _throttle(self) -> None:
        """请求间隔限流：两次 PROPFIND 之间至少隔 SCAN_RATE_LIMIT 秒。
        云端文件极多时疯狂请求会被限流/封禁，这里主动踩刹车。"""
        if SCAN_RATE_LIMIT <= 0:
            return
        with self._rate_lock:
            wait = SCAN_RATE_LIMIT - (time.monotonic() - self._last_request_at)
            if wait > 0:
                time.sleep(wait)
            self._last_request_at = time.monotonic()

    def _retryable_status(self, status: int) -> bool:
        # status==0 表示连接/网络层错误（无 HTTP 状态码，如 TLS 握手超时、
        # 连接被拒），实测 123 云盘会间歇性出现，同样值得重试
        return status == 0 or status == 429 or status >= 500 or status == 408

    def _build_opener(self) -> urllib.request.OpenerDirector:
        handlers: list[Any] = [urllib.request.HTTPRedirectHandler(),
                               # 显式直连：WebDAV 是用户显式配置的服务器地址，
                               # 不应被 http_proxy 等环境变量劫持
                               #（实测：沙箱/挂代理的机器上 123 云盘 TLS 握手直接被代理切断）
                               urllib.request.ProxyHandler({})]
        if self.base_url.lower().startswith("https"):
            handlers.append(urllib.request.HTTPSHandler(context=_ssl_ctx(self.verify_ssl)))
        if self.username:
            handlers.append(_BasicAuthHandler(self.username, self.password))
        return urllib.request.build_opener(*handlers)

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"User-Agent": _UA}
        if self.username:
            h["Authorization"] = _basic_auth(self.username, self.password)
        if extra:
            h.update(extra)
        return h

    def _open(self, req: urllib.request.Request, timeout: int | None = None):
        try:
            return self._opener.open(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()[:400]
            except Exception:
                pass
            detail = body.decode("utf-8", "replace").strip()
            raise WebDAVError(
                f"HTTP {e.code} {e.reason}" + (f" — {detail}" if detail else ""), e.code
            ) from e
        except urllib.error.URLError as e:
            raise WebDAVError(f"连接失败：{e.reason}") from e
        except (TimeoutError, OSError) as e:
            raise WebDAVError(f"网络错误：{e}") from e

    def _open_retry(self, req: urllib.request.Request, timeout: int = 15,
                    retries: int = 2):
        """带重试的打开。仅对**瞬态**错误重试（连接失败/TLS 握手超时/5xx/429），
        401/403/404 等确定性错误立即抛出。

        实测 123 云盘会间歇性「TLS 握手超时/SSL EOF」—— 不重试的话一次抖动
        就让播放报错。打开阶段用短超时（握手失败快速重试），避免 60s 超时
        让一次失败拖三分钟。"""
        last: WebDAVError | None = None
        for attempt in range(retries + 1):
            try:
                return self._opener.open(req, timeout=timeout)
            except urllib.error.HTTPError as e:
                if self._retryable_status(e.code) and attempt < retries:
                    last = WebDAVError(f"HTTP {e.code} {e.reason}", e.code)
                    time.sleep(0.6 * (2 ** attempt))
                    continue
                body = b""
                try:
                    body = e.read()[:400]
                except Exception:
                    pass
                detail = body.decode("utf-8", "replace").strip()
                raise WebDAVError(
                    f"HTTP {e.code} {e.reason}" + (f" — {detail}" if detail else ""), e.code
                ) from e
            except urllib.error.URLError as e:
                last = WebDAVError(f"连接失败：{e.reason}")
                if attempt < retries:
                    time.sleep(0.6 * (2 ** attempt))
                    continue
                raise last from e
            except (TimeoutError, OSError) as e:
                last = WebDAVError(f"网络错误：{e}")
                if attempt < retries:
                    time.sleep(0.6 * (2 ** attempt))
                    continue
                raise last from e
        raise last or WebDAVError("打开失败")  # pragma: no cover

    # ---------- 目录列举 ----------

    def list_dir(self, path: str = "/") -> list[dict[str, Any]]:
        """PROPFIND depth:1，返回该层级的条目（不含自身）。

        带限流节拍 + 指数退避重试：429/5xx/网络错误会自动重试若干次，
        避免云端文件过多时一次抖动就中断整个扫描。"""
        body = (
            b'<?xml version="1.0" encoding="utf-8" ?>'
            b'<D:propfind xmlns:D="DAV:"><D:prop>'
            b"<D:resourcetype/><D:getcontentlength/><D:getlastmodified/>"
            b"<D:getcontenttype/><D:displayname/>"
            b"</D:prop></D:propfind>"
        )
        url = join_url(self.base_url, path)

        last_err: WebDAVError | None = None
        for attempt in range(SCAN_RETRIES + 1):
            self._throttle()
            req = urllib.request.Request(
                url, data=body, method="PROPFIND",
                headers=self._headers({"Depth": "1", "Content-Type": "application/xml; charset=utf-8"}),
            )
            try:
                with self._open(req) as resp:
                    data = resp.read()
                return self._parse_multistatus(data, path)
            except WebDAVError as e:
                last_err = e
                if not self._retryable_status(e.status) or attempt >= SCAN_RETRIES:
                    raise
                # 指数退避；429 额外多等一会儿
                wait = SCAN_RETRY_BACKOFF * (2 ** attempt)
                if e.status == 429:
                    wait += SCAN_429_EXTRA_WAIT
                time.sleep(wait)
        raise last_err  # pragma: no cover —— 上面循环必然 return 或 raise

    def list_tree(self, root: str = "/", max_depth: int = 8,
                  on_progress=None, should_stop=None,
                  on_error=None, exclude: set[str] | None = None) -> Iterator[dict[str, Any]]:
        """深度优先遍历，逐个产出文件条目（带去重与目录跳过）。

        认证/权限类错误（401/403）必须向上抛 —— 否则整个扫描会「成功但 0 个文件」，
        用户完全看不出是密码错了还是网盘真为空。404 之类的目录级错误则跳过继续，
        **但会通过 on_error(路径, 错误) 上报**——大目录超时若静默跳过，整个子树的
        文件都会无声消失，用户扫出的数量对不上网盘显示的总数。

        should_stop: 可选回调，返回 True 时立即中断遍历（用于暂停/取消扫描）。
        exclude: 需要排除的目录名集合（不含路径，大小写不敏感）。
        """
        self._exclude = {x.lower() for x in (exclude or ())}
        stack: list[tuple[str, int]] = [(self._norm(root), 0)]
        visited: set[str] = set()
        auth_failed = False
        while stack:
            if should_stop and should_stop():
                return
            path, depth = stack.pop()
            if path in visited or depth > max_depth:
                continue
            visited.add(path)
            try:
                entries = self.list_dir(path)
            except WebDAVError as e:
                if e.status in (401, 403):
                    auth_failed = True
                    break
                # 404 / 405 等：这一层拿不到。但**绝不能静默丢**——
                # 大目录超时时整个子树都会消失，用户扫出的数量会对不上。
                # 失败目录由 on_error 回调（scanner.on_dir_error）计入 failed_dirs 并写日志，
                # 这里只负责继续下钻，不要引用 webdav 作用域里不存在的 failed_dirs。
                failed_dirs.append((path, str(e)))
                if on_error:
                    on_error(path, str(e))
                continue  # 跳过该目录继续下钻
            dir_seen: set[str] = set()   # 部分 WebDAV（123 等）同一响应会返回重复条目
            for entry in entries:
                if entry["is_dir"]:
                    name = entry["name"].lower()
                    if name in SKIP_DIRS or name.startswith("."):
                        continue
                    if self._excluded(entry["path"]):
                        continue
                    stack.append((entry["path"], depth + 1))
                else:
                    if entry["path"] in dir_seen:
                        continue
                    dir_seen.add(entry["path"])
                    yield entry
            if on_progress:
                on_progress(len(visited), path)
            if should_stop and should_stop():
                return

        if auth_failed:
            raise WebDAVError("认证失败：账号或密码不正确（HTTP 401/403）", 401)

    def _excluded(self, path: str) -> bool:
        """目录是否命中排除名单（按目录名匹配，大小写不敏感）。"""
        if not self._exclude:
            return False
        for seg in path.strip("/").split("/"):
            if seg.lower() in self._exclude:
                return True
        return False

    @staticmethod
    def _norm(path: str) -> str:
        p = path or "/"
        if not p.startswith("/"):
            p = "/" + p
        return p.rstrip("/") or "/"

    def _parse_multistatus(self, data: bytes, base_path: str) -> list[dict[str, Any]]:
        try:
            root = ET.fromstring(data)
        except ET.ParseError as e:
            raise WebDAVError(f"PROPFIND 响应不是合法 XML：{e}") from e

        base_prefix = urllib.parse.urlsplit(self.base_url).path.rstrip("/")
        out: list[dict[str, Any]] = []
        for resp in root.findall(f"{{{DAV_NS}}}response"):
            href_el = resp.find(f"{{{DAV_NS}}}href")
            if href_el is None or not href_el.text:
                continue
            href = urllib.parse.unquote(href_el.text.strip())
            # 去掉服务器挂载前缀，得到相对 base 的部分
            if base_prefix and href.startswith(base_prefix):
                href = href[len(base_prefix):]
            path = urllib.parse.urlsplit(href).path or "/"
            if not path.startswith("/"):
                path = "/" + path

            propstat_ok = False
            is_dir = False
            size = 0
            mtime = None
            mime = ""
            display = ""
            for ps in resp.findall(f"{{{DAV_NS}}}propstat"):
                status_el = ps.find(f"{{{DAV_NS}}}status")
                status_txt = status_el.text if status_el is not None else ""
                if status_txt and " 200 " not in status_txt:
                    continue
                propstat_ok = True
                prop = ps.find(f"{{{DAV_NS}}}prop")
                if prop is None:
                    continue
                rt = prop.find(f"{{{DAV_NS}}}resourcetype")
                if rt is not None and rt.find(f"{{{DAV_NS}}}collection") is not None:
                    is_dir = True
                cl = prop.find(f"{{{DAV_NS}}}getcontentlength")
                if cl is not None and cl.text:
                    try:
                        size = int(cl.text.strip())
                    except ValueError:
                        size = 0
                lm = prop.find(f"{{{DAV_NS}}}getlastmodified")
                if lm is not None:
                    mtime = parse_http_date(lm.text)
                ct = prop.find(f"{{{DAV_NS}}}getcontenttype")
                if ct is not None and ct.text:
                    mime = ct.text.split(";")[0].strip()
                dn = prop.find(f"{{{DAV_NS}}}displayname")
                if dn is not None and dn.text:
                    display = dn.text.strip()

            if not propstat_ok:
                continue

            norm_base = self._norm(base_path)
            if path.rstrip("/") == norm_base or path == norm_base:
                continue  # 跳过目录自身

            name = display or urllib.parse.unquote(path.rstrip("/").rsplit("/", 1)[-1])
            folder = path.rstrip("/").rsplit("/", 1)[0] or "/"
            if folder == path.rstrip("/"):
                folder = "/"
            ext = split_ext(name)
            kind = KIND_BY_EXT.get(ext, "other")
            if kind == "other" and is_dir is False and mime:
                low = mime.lower()
                if low.startswith("video/"):
                    kind = "video"
                elif low.startswith("audio/"):
                    kind = "audio"
                elif low.startswith("image/"):
                    kind = "image"
            if is_dir:
                kind = "dir"
            out.append({
                "name": name, "path": path, "is_dir": is_dir, "size": size,
                "mtime": mtime, "mime": mime or MIME_BY_EXT.get(ext, ""),
                "ext": ext, "kind": kind, "folder": folder,
            })
        return out

    # ---------- 读取 ----------

    def stream(self, path: str, range_header: str | None = None,
               timeout: int = 60) -> tuple[Any, dict[str, str]]:
        """打开远端文件。返回 (响应对象, 响应头字典)。调用方负责关闭。

        打开阶段带重试（123 云盘 TLS 握手间歇性超时），短超时快速失败快速重试；
        一旦打开成功，后续读取由调用方控制（resp.read 的 socket 超时即此 timeout）。"""
        url = join_url(self.base_url, path)
        headers = self._headers({"Accept": "*/*"})
        if range_header:
            headers["Range"] = range_header
        req = urllib.request.Request(url, method="GET", headers=headers)
        resp = self._open_retry(req, timeout=min(timeout, 15))
        head = {k.lower(): v for k, v in resp.headers.items()}
        return resp, head

    def head(self, path: str, timeout: int = 20) -> dict[str, Any]:
        url = join_url(self.base_url, path)
        req = urllib.request.Request(url, method="HEAD", headers=self._headers())
        with self._open(req, timeout=timeout) as resp:
            return {k.lower(): v for k, v in resp.headers.items()}

    def exists(self, path: str) -> bool:
        try:
            self.head(path, timeout=10)
            return True
        except WebDAVError:
            return False

    def delete(self, path: str) -> bool:
        url = join_url(self.base_url, path)
        req = urllib.request.Request(url, method="DELETE", headers=self._headers())
        try:
            with self._opener.open(req, timeout=self.timeout):
                return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return True
            raise WebDAVError(f"删除失败 HTTP {e.code}", e.code) from e


class _BasicAuthHandler(urllib.request.BaseHandler):
    """urllib 默认不发送 Authorization 头，这里补一个 handler。"""

    def __init__(self, user: str, password: str):
        self._auth = _basic_auth(user, password)

    def http_request(self, req: urllib.request.Request) -> urllib.request.Request:
        if "Authorization" not in req.headers:
            req.add_header("Authorization", self._auth)
        return req

    https_request = http_request


def make_client(source: dict[str, Any]) -> WebDAVClient:
    from .config import SCAN_HTTP_TIMEOUT
    return WebDAVClient(
        source["base_url"],
        source.get("username") or "",
        source.get("password") or "",
        verify_ssl=bool(source.get("verify_ssl", 1)),
        timeout=SCAN_HTTP_TIMEOUT,
    )
