#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：字幕关联（同目录同名 .srt/.vtt）与字幕流读取。

自包含：同进程起假 WebDAV + 主服务，数据目录用独立临时目录，
与用户数据、其他测试端口完全隔离。
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

# 隔离数据目录 + 提速：必须在 import backend 之前设置（config 在导入时读环境变量）
os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-sub-test-")
os.environ.setdefault("WEBSUA_SCAN_RATE", "0")
os.environ.setdefault("WEBSUA_SCAN_RETRIES", "0")
os.environ.setdefault("WEBSUA_SCAN_BACKOFF", "0")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fake_dav
from backend.server import serve

PORT = 8931
DAV_PORT = 8932

SRT = (
    "1\n"
    "00:00:01,000 --> 00:00:04,000\n"
    "第一句字幕\n\n"
    "2\n"
    "00:00:05,500 --> 00:00:07,000\n"
    "第二句字幕\n\n"
).encode("utf-8")

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


def req(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(r, timeout=40) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def raw(path):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}")
    try:
        with op.open(r, timeout=40) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


# ---- 构造含字幕的虚拟文件树 ----
fake_dav.build_fixture()
fake_dav.FILES["/视频/我的影片.mp4"] = (bytes(4000), "video/mp4")
fake_dav.FILES["/视频/我的影片.srt"] = (SRT, "application/x-subrip")      # 主规则：同名不同扩展名
fake_dav.FILES["/视频/另一部.mp4"] = (bytes(4000), "video/mp4")
fake_dav.FILES["/视频/另一部.mp4.srt"] = (SRT, "application/x-subrip")    # 变体：视频全名 + .srt
fake_dav.FILES["/视频/我的影片.ass"] = (SRT, "text/x-ssa")                # 不支持，应被忽略
fake_dav.FILES["孤儿字幕.srt"] = (SRT, "application/x-subrip")             # 无对应视频，应被剔除

dav = ThreadingHTTPServer(("127.0.0.1", DAV_PORT), fake_dav.Handler)
dav.daemon_threads = True
threading.Thread(target=dav.serve_forever, daemon=True).start()

app = serve("127.0.0.1", PORT)
time.sleep(0.5)

print("=" * 62)
print("字幕关联与读取")
print("=" * 62)

_, d = req("/api/sources")
for s in d.get("sources", []):
    req(f"/api/sources/{s['id']}", "DELETE")

st, d = req("/api/sources", "POST", {
    "name": "字幕源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/"})
sid = d["id"]
_, t = req(f"/api/sources/{sid}/scan", "POST")
tid = t["task"]["id"]
for _ in range(60):
    time.sleep(0.3)
    _, r = req(f"/api/tasks/{tid}")
    if r["task"]["state"] in ("done", "failed"):
        break
task = r["task"]
check("扫描成功", task["state"] == "done",
      f"state={task['state']} found={task.get('found')}")

_, all_m = req("/api/media?limit=200")
every = all_m["media"]

# 字幕 / .ass / 孤儿字幕都不该作为独立媒体入列
leaked = [x["name"] for x in every
          if (x.get("ext") or "").lower() in (".srt", ".vtt", ".ass", ".ssa")]
check("字幕类文件不单独进媒体库", not leaked, f"泄漏：{leaked}")

videos = {x["name"]: x for x in every if x.get("kind") == "video"}
v1 = videos.get("我的影片.mp4")
v2 = videos.get("另一部.mp4")
check("两个视频均已索引", bool(v1 and v2), f"视频数={len(videos)}")

if v1:
    check("我的影片 关联字幕（主规则）", bool(v1.get("subtitle")), v1.get("subtitle") or "无")
if v2:
    check("另一部 关联字幕（全名+.srt 变体）", bool(v2.get("subtitle")), v2.get("subtitle") or "无")

# 无字幕的视频：接口应 404
no_sub = next((x for x in every if x.get("kind") == "video" and not x.get("subtitle")), None)
if no_sub:
    st, h, body = raw(f"/api/subtitle/{no_sub['id']}")
    check("无字幕时 /api/subtitle 返回 404", st == 404, f"status={st}")

if v1 and v1.get("subtitle"):
    st, h, body = raw(v1["subtitle"])
    check("字幕流返回 200", st == 200, f"status={st}")
    check("按原文返回（未提前转 VTT，转换在前端）",
          b"WEBVTT" not in body and b"00:00:01,000" in body)
    ct = h.get("Content-Type") or ""
    check("Content-Type 为 subrip", "subrip" in ct, ct)

app.shutdown()
dav.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
