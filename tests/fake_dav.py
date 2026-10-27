"""本地假 WebDAV 服务器：用于验证 PROPFIND 解析与 Range 流转发。

支持：
  - PROPFIND depth:0/1，返回标准 multistatus
  - GET + Range，正确返回 206 / Content-Range
  - 可选 Basic 认证（验证凭据传递）
  - 故意忽略 Range 的「坏服务器」模式，用于测试端点回退
"""
from __future__ import annotations

import base64
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

# 虚拟文件表：路径 -> (内容 bytes, 类型)
FILES: dict[str, tuple[bytes, str]] = {}

# 可按文件覆盖的 Last-Modified（增量扫描测试用：同大小但改过 mtime）。
# 缺省用 DEFAULT_LM —— 与线上网盘一样，多数服务器对所有文件返回同一时间。
MTIMES: dict[str, str] = {}
DEFAULT_LM = "Mon, 03 Oct 2026 10:00:00 GMT"

MIME = {
    ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm",
    ".jpg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg",
}

IGNORE_RANGE = False
REQUIRE_AUTH: tuple[str, str] | None = None

# 测试「目录列举失败」场景：这些目录（规范化、含结尾斜杠）的 PROPFIND
# 返回 500，模拟网盘大目录超时报错 —— 验证失败目录被上报、可重扫、不静默丢弃。
# 也可通过环境变量 WEBSUA_BROKEN_DIRS（逗号分隔的路径）在启动时注入，便于浏览器测试。
BROKEN_DIRS: set[str] = set()


def build_fixture():
    """构造一棵虚拟目录树，含中文名、空格、嵌套目录。

    若 tests/fixtures/ 下有真实 webm（由 gen_media.js 用 MediaRecorder 生成），
    优先用真视频 —— 随机字节无法被浏览器解码，没法验证缩略图截帧。
    """
    FILES.clear()
    fixtures: dict[str, tuple[bytes, str]] = {}
    fdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
    if os.path.isdir(fdir):
        for fn in sorted(os.listdir(fdir)):
            fp = os.path.join(fdir, fn)
            if not os.path.isfile(fp):
                continue
            with open(fp, "rb") as f:
                data = f.read()
            ext = os.path.splitext(fn)[1].lower()
            if ext == ".webm":
                fixtures[fn] = (data, "video/webm")
            elif ext in (".jpg", ".jpeg"):
                fixtures[fn] = (data, "image/jpeg")
            elif ext == ".png":
                fixtures[fn] = (data, "image/png")

    files = {
        "/": [],
        "/视频/": ["片子 A.mp4", "片子 B.mkv", "空文件.webm"],
        "/视频/子目录/": ["深层视频.mp4"],
        "/图片/": ["风景.jpg", "头像.png"],
        "/音乐/": ["曲目一.mp3"],
        "/混合 目录/": ["测试文件.txt", "视频 01.mp4"],
    }
    # 有真素材时：三个目录各放一个真视频 + 同名封面图，其余保持占位
    if fixtures:
        real_webms = [n for n in fixtures if n.endswith(".webm")]
        if real_webms:
            w1 = real_webms[0]
            w2 = real_webms[1] if len(real_webms) > 1 else w1
            w3 = real_webms[2] if len(real_webms) > 2 else w1
            files["/视频/"] = [w1, "片子 B.mkv", "空文件.webm"]
            files["/视频/子目录/"] = [w2, "深层视频.mp4"]
            files["/混合 目录/"] = ["测试文件.txt", w3]
            # 同名封面图放到与视频相同目录，模拟 TG 导出
            for w in (w1, w2, w3):
                jpg = w[:-5] + ".jpg"
                if jpg in fixtures:
                    folder = "/视频/" if w == w1 else "/视频/子目录/" if w == w2 else "/混合 目录/"
                    files[folder].append(jpg)

    for root, names in files.items():
        for n in names:
            ext = os.path.splitext(n)[1].lower()
            if n in fixtures:
                data, mime = fixtures[n]
            else:
                size = 200_000 if ext in MIME else 1234
                data, mime = bytes(os.urandom(size)), MIME.get(ext, "application/octet-stream")
            FILES[root + n] = (data, mime)
    # 额外补一个中文深层路径，验证 URL 编码
    real_webms = [n for n in fixtures if n.endswith(".webm")]
    extra = fixtures.get(real_webms[0]) if real_webms else None
    if extra:
        FILES["/视频/子目录/中文 名 video.webm"] = extra
    else:
        FILES["/视频/子目录/中文 名 video.mp4"] = (
            bytes(os.urandom(200_000)), "video/mp4")

    # 批量子目录：拉长扫描时间（0.25s 限流 × N 目录），给「暂停/停止」
    # 的测试留出足够的操作窗口；也验证大量目录下的遍历稳定性。
    filler = extra or (bytes(os.urandom(50_000)), "video/webm")
    for i in range(1, 25):
        FILES[f"/批量/目录{i:02d}/第{i}集.webm"] = filler

    # 番剧目录：一整季连续剧，验证「播放队列」按目录自然序生成下一集
    # （第2集必须排在第10集前面 —— 字典序会把 10 排到 2 前面）
    for i in range(1, 13):
        FILES[f"/番剧/第{i}集.mp4"] = filler

def dirs_of(path: str) -> set[str]:
    """从文件表推导所有目录。"""
    out = {"/"}
    for p in FILES:
        parts = p.strip("/").split("/")
        for i in range(1, len(parts)):
            out.add("/" + "/".join(parts[:i]) + "/")
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ---- 认证 ----
    def _auth_ok(self) -> bool:
        if not REQUIRE_AUTH:
            return True
        hdr = self.headers.get("Authorization", "")
        if not hdr.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(hdr[6:]).decode()
        except Exception:
            return False
        return raw == f"{REQUIRE_AUTH[0]}:{REQUIRE_AUTH[1]}"

    def _deny(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="WebDAV"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- PROPFIND ----
    def do_PROPFIND(self):
        if not self._auth_ok():
            return self._deny()
        path = unquote(urlsplit(self.path).path)
        # 挂载点 /dav 只是服务器前缀，虚拟文件表用的是不含它的路径
        if path.startswith("/dav"):
            path = path[4:] or "/"
        # 故意让某些目录列举失败（返回 500）—— 用于失败目录重扫测试
        norm_check = path if path.endswith("/") else path + "/"
        if norm_check in BROKEN_DIRS:
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        depth = self.headers.get("Depth", "1")
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)

        norm = path if path.endswith("/") else path + "/"
        all_dirs = dirs_of(norm)

        parts = [
            f'<?xml version="1.0" encoding="utf-8"?>',
            '<D:multistatus xmlns:D="DAV:">',
        ]

        def entry(href, is_dir, size=0, mime=""):
            rt = "<D:collection/>" if is_dir else ""
            # href 是 quote 过的（中文名会变成 %XX），查 MTIMES 要先解码
            lm = MTIMES.get(unquote(href[len("/dav"):]), DEFAULT_LM)
            cl = "" if is_dir else f"<D:getcontentlength>{size}</D:getcontentlength>"
            ct = "" if is_dir else f"<D:getcontenttype>{mime}</D:getcontenttype>"
            return (
                f"<D:response><D:href>{href}</D:href><D:propstat><D:prop>"
                f"<D:resourcetype>{rt}</D:resourcetype>{cl}"
                f"<D:getlastmodified>{lm}</D:getlastmodified>{ct}"
                f"</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
            )

        parts.append(entry(norm, True))
        if depth != "0":
            # 该目录下的直接子项（按「路径段数」判断直属，而不是找斜杠 ——
            # 目录名本身含斜杠分隔的层级，只有多出一段才算子项）
            def depth_of(p: str) -> int:
                return len([x for x in p.strip("/").split("/") if x])

            base_depth = depth_of(norm)
            for p, (data, mime) in FILES.items():
                if not p.startswith(norm):
                    continue
                if depth_of(p) == base_depth + 1:
                    parts.append(entry(self._href(p), False, len(data), mime))
            for d in sorted(all_dirs):
                if d == norm or not d.startswith(norm):
                    continue
                if depth_of(d) == base_depth + 1:
                    parts.append(entry(self._href(d), True))
        parts.append("</D:multistatus>")
        body = "".join(parts).encode("utf-8")

        self.send_response(207)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _href(self, p: str) -> str:
        from urllib.parse import quote
        return quote("/dav" + p)

    # ---- GET ----
    def do_GET(self):
        if not self._auth_ok():
            return self._deny()
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/dav"):
            path = path[4:]
        if path not in FILES:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        data, mime = FILES[path]
        rng = self.headers.get("Range")

        if rng and not IGNORE_RANGE:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                s, e = m.group(1), m.group(2)
                total = len(data)
                if s == "":
                    start = max(0, total - int(e)); end = total - 1
                else:
                    start = int(s)
                    end = int(e) if e else total - 1
                    end = min(end, total - 1)
                if start >= total:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                chunk = data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(chunk)))
                self.end_headers()
                self.wfile.write(chunk)
                return

        # 全量（坏服务器模式也会走这里）
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(data)

    do_HEAD = do_GET

    def do_DELETE(self):
        """删除远端文件（测试「索引还在但远端已消失」场景）。"""
        if not self._auth_ok():
            return self._deny()
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/dav"):
            path = path[4:] or "/"
        if path in FILES:
            del FILES[path]
            self.send_response(204)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def serve(port, auth=None, ignore_range=False, builder=None):
    """在后台线程起假服务器。

    builder: 自定义文件表构造函数（返回 {路径: (内容, MIME)}）。
        一键演示（demo.py）用它铺一棵好看的演示目录树；
        不传则用测试用的默认 fixture。
    """
    global REQUIRE_AUTH, IGNORE_RANGE
    REQUIRE_AUTH = auth
    IGNORE_RANGE = ignore_range
    if builder is not None:
        FILES.clear()
        FILES.update(builder())
    else:
        build_fixture()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _apply_broken_env() -> None:
    """从 WEBSUA_BROKEN_DIRS 注入坏目录（逗号分隔），便于浏览器测试启动即带故障。"""
    raw = os.environ.get("WEBSUA_BROKEN_DIRS", "")
    for part in raw.split(","):
        p = part.strip()
        if p:
            # 规范化：确保以 / 开头、以 / 结尾，与 do_PROPFIND 的判定一致
            if not p.startswith("/"):
                p = "/" + p
            BROKEN_DIRS.add(p if p.endswith("/") else p + "/")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    mode = sys.argv[2] if len(sys.argv) > 2 else "good"
    auth = ("user", "pass") if mode == "auth" else None
    ignore = mode == "norange"
    # 必须设模块级全局 —— Handler 内部读的就是它们。
    # 原来这里只调了 build_fixture，导致 auth / norange 两种模式实际没生效。
    REQUIRE_AUTH = auth
    IGNORE_RANGE = ignore
    build_fixture()
    _apply_broken_env()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print(f"假 WebDAV 运行于 http://127.0.0.1:{port}/dav  模式={mode}"
          f"{'（需认证 user/pass）' if auth else ''}"
          f"{'（忽略 Range）' if ignore else ''}")
    sys.stdout.flush()
    srv.serve_forever()
