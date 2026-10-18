#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：播放队列（v1.4.0）—— 目录自然序 + 队列持久化接口。

覆盖：
  1. order=natural：第2集必须排在第10集前面（字典序会把 10 排到 2 前）
  2. 自然序分页：排序后再切片，offset 落在正确的集数上
  3. /api/queue 保存 → 读取：顺序/index/mode/shuffle/enabled 原样往返
  4. 失效 id（不存在/源被停用）在读取时自动剔除
  5. 非法 payload 回 400，mode 越界归一化为 off

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
os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-queue-test-")
os.environ.setdefault("WEBSUA_SCAN_RATE", "0")
os.environ.setdefault("WEBSUA_SCAN_RETRIES", "0")
os.environ.setdefault("WEBSUA_SCAN_BACKOFF", "0")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fake_dav
from backend.server import serve

PORT = 8941
DAV_PORT = 8942

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


# ---- 构造含「番剧目录」的虚拟文件树 ----
fake_dav.build_fixture()
EPISODES = 12
for i in range(1, EPISODES + 1):
    fake_dav.FILES[f"/剧集/第{i}集.mp4"] = (bytes(300_000), "video/mp4")
fake_dav.FILES["/剧集/看前必读.txt"] = (bytes(1234), "text/plain")   # 非视频，应被自然序查询排除

dav = ThreadingHTTPServer(("127.0.0.1", DAV_PORT), fake_dav.Handler)
dav.daemon_threads = True
threading.Thread(target=dav.serve_forever, daemon=True).start()

app = serve("127.0.0.1", PORT)
time.sleep(0.5)

print("=" * 62)
print("播放队列：自然序与持久化")
print("=" * 62)

_, d = req("/api/sources")
for s in d.get("sources", []):
    req(f"/api/sources/{s['id']}", "DELETE")

st, d = req("/api/sources", "POST", {
    "name": "队列源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/"})
sid = d["id"]
_, t = req(f"/api/sources/{sid}/scan", "POST")
tid = t["task"]["id"]
for _ in range(80):
    time.sleep(0.3)
    _, r = req(f"/api/tasks/{tid}")
    if r["task"]["state"] in ("done", "failed"):
        break
check("扫描成功", r["task"]["state"] == "done", f"state={r['task']['state']}")

# ---- 1. 自然序 ----
_, d = req("/api/media?folder=" + urllib.request.quote("/剧集")
           + "&kinds=video&order=natural&limit=200")
names = [m["name"] for m in d["media"]]
check("目录查询只返回视频", len(names) == EPISODES, f"数量={len(names)}")
check("第1集在最前", names[:1] == ["第1集.mp4"], str(names[:3]))
check("第2集排在第10集前面（自然序，非字典序）",
      names.index("第2集.mp4") < names.index("第10集.mp4"),
      f"第2集@{names.index('第2集.mp4')} 第10集@{names.index('第10集.mp4')}")
expected = [f"第{i}集.mp4" for i in range(1, EPISODES + 1)]
check("整表自然序", names == expected, str(names))

# ---- 2. 自然序分页：排序后再切片 ----
_, d2 = req("/api/media?folder=" + urllib.request.quote("/剧集")
            + "&kinds=video&order=natural&limit=5&offset=10")
check("自然序分页落在正确的集数上",
      [m["name"] for m in d2["media"]] == ["第11集.mp4", "第12集.mp4"],
      str([m["name"] for m in d2["media"]]))
check("自然序 total 为全量", d2["total"] == EPISODES, f"total={d2['total']}")

episodes = {m["name"]: m["id"] for m in d["media"]}
e1, e2, e3, e10 = (episodes["第1集.mp4"], episodes["第2集.mp4"],
                   episodes["第3集.mp4"], episodes["第10集.mp4"])

# ---- 3. 队列保存 → 读取 ----
st, _ = req("/api/queue", "POST", {
    "ids": [e3, e1, e2], "index": 1, "mode": "all",
    "shuffle": True, "enabled": True, "origin": "/剧集",
})
check("保存队列返回 200", st == 200, f"status={st}")
_, q = req("/api/queue")
check("读取的顺序与保存一致",
      [m["name"] for m in q["queue"]["items"]] == ["第3集.mp4", "第1集.mp4", "第2集.mp4"],
      str([m["name"] for m in q["queue"]["items"]]))
check("index 原样往返", q["queue"]["index"] == 1, str(q["queue"]["index"]))
check("mode/shuffle/enabled/origin 原样往返",
      q["queue"]["mode"] == "all" and q["queue"]["shuffle"] is True
      and q["queue"]["enabled"] is True and q["queue"]["origin"] == "/剧集",
      json.dumps({k: q["queue"][k] for k in ("mode", "shuffle", "enabled", "origin")}))
check("ids 与 items 对齐", q["queue"]["ids"] == [e3, e1, e2], str(q["queue"]["ids"]))

# ---- 4. 失效 id 剔除 ----
st, _ = req("/api/queue", "POST", {
    "ids": [e1, 999999, e2], "index": 0, "mode": "off",
    "shuffle": False, "enabled": False, "origin": "/剧集",
})
check("含失效 id 的保存仍返回 200", st == 200, f"status={st}")
_, q = req("/api/queue")
check("不存在的 id 被剔除", q["queue"]["ids"] == [e1, e2], str(q["queue"]["ids"]))
check("enabled=false 原样往返（清空后不自动生成）", q["queue"]["enabled"] is False)

# index 越界夹紧到合法范围
st, _ = req("/api/queue", "POST", {"ids": [e1, e2], "index": 99})
_, q = req("/api/queue")
check("index 越界被夹紧", q["queue"]["index"] == 1, str(q["queue"]["index"]))

# ---- 5. 非法 payload ----
st, _ = req("/api/queue", "POST", {"ids": "not-a-list"})
check("ids 不是数组 → 400", st == 400, f"status={st}")
st, _ = req("/api/queue", "POST", {"ids": [-5]})
check("id 为负 → 400", st == 400, f"status={st}")
st, _ = req("/api/queue", "POST", {"ids": ["abc"]})
check("id 非数字 → 400", st == 400, f"status={st}")
st, _ = req("/api/queue", "POST", {"ids": [e1], "mode": "bogus"})
check("mode 越界归一化为 off（仍 200）", st == 200, f"status={st}")
_, q = req("/api/queue")
check("归一化后的 mode 为 off", q["queue"]["mode"] == "off", q["queue"]["mode"])

# ---- 6. 停用源后队列内容不可见 ----
st, _ = req(f"/api/sources/{sid}", "PUT", {"enabled": False})
_, q = req("/api/queue")
check("停用源后队列内容被清空（可见性一致）",
      q["queue"]["items"] == [] and q["queue"]["ids"] == [],
      f"items={len(q['queue']['items'])}")
req(f"/api/sources/{sid}", "PUT", {"enabled": True})

# ---- 7. 清空 ----
st, _ = req("/api/queue", "DELETE")
_, q = req("/api/queue")
check("DELETE 后队列为空", q["queue"]["ids"] == [] and q["queue"]["index"] == -1,
      json.dumps({k: q["queue"][k] for k in ("ids", "index")}))

app.shutdown()
dav.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
