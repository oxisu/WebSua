#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：子目录列举出错（HTTP 500）时，WebDAVClient.list_tree 不得抛 NameError，
而应调用 on_error 回调并继续遍历其余目录。

锁住 WebSua v1.0.0 修复的崩溃 bug：
  修复前 webdav.list_tree 在非认证子目录错误（超时 / 404 / 408 / 5xx / 连接层错误）
  的分支里引用了作用域外不存在的 failed_dirs 变量，抛 NameError，被 scanner
  顶层 except 接住后整轮扫描被标记为 FAILED。修复后只调用 on_error 并继续下钻。
"""
import os
import sys
import threading
import time
import urllib.parse

# 提速：关闭限流 / 重试 / 退避（必须在 import backend 之前设置，config 在导入时读环境变量）
os.environ.setdefault("WEBSUA_SCAN_RATE", "0")
os.environ.setdefault("WEBSUA_SCAN_RETRIES", "0")
os.environ.setdefault("WEBSUA_SCAN_BACKOFF", "0")
os.environ.setdefault("WEBSUA_SCAN_429_WAIT", "0")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fake_dav
from http.server import ThreadingHTTPServer
from backend.webdav import WebDAVError, WebDAVClient

PORT = 8911
BROKEN_DIR = "/坏目录"


class BrokenHandler(fake_dav.Handler):
    """正常目录走父类逻辑；对 /坏目录/ 及其子目录的 PROPFIND 一律返回 500。"""

    def do_PROPFIND(self):
        p = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if p.startswith("/dav"):
            p = p[4:] or "/"
        if p == BROKEN_DIR or p.startswith(BROKEN_DIR + "/"):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return super().do_PROPFIND()


PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


# ---- 起服务器：构造含坏目录的虚拟文件树 ----
fake_dav.build_fixture()
fake_dav.FILES[BROKEN_DIR + "/损坏的视频.mp4"] = (bytes(1024), "video/mp4")
srv = ThreadingHTTPServer(("127.0.0.1", PORT), BrokenHandler)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.4)

print("=" * 62)
print("子目录列举失败时的降级（回归 v1.0.0 崩溃 bug）")
print("=" * 62)

client = WebDAVClient(f"http://127.0.0.1:{PORT}/dav")
errors = []
try:
    items = list(client.list_tree("/", max_depth=8, on_error=lambda p, e: errors.append((p, e))))
    check("list_tree 在子目录出错时不抛异常（不退化成 NameError）", True)
except Exception as e:  # noqa: BLE001
    check("list_tree 在子目录出错时不抛异常（不退化成 NameError）", False,
          f"{type(e).__name__}: {e}")

# 坏目录应被上报
broken_reported = any(BROKEN_DIR in p for p, _ in errors)
check("失败目录被 on_error 回调上报", broken_reported,
      f"上报了 {len(errors)} 个目录: {[p for p, _ in errors]}")

# 其余正常目录的文件仍应被遍历到（降级而非中断）
healthy = [it for it in items if BROKEN_DIR not in it["path"]]
check("正常目录的文件仍被遍历（降级而非整轮停止）", len(healthy) > 0,
      f"正常文件数={len(healthy)}")

# 坏目录的文件不应出现（其父目录 PROPFIND 失败，子项从未被列举）
broken_files = [it for it in items if BROKEN_DIR in it["path"]]
check("坏目录下的文件未泄漏进结果", len(broken_files) == 0,
      f"泄漏 {len(broken_files)} 个")

# 健康目录 /视频/ 下的文件仍能被遍历到
has_known = any(it["path"].startswith("/视频/") for it in items)
check("仍能遍历到健康目录 /视频/ 下的文件", has_known)

srv.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
