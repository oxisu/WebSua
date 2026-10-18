#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：失败目录重扫 + 扫描差异报告（v1.6.0）。

覆盖：
  1. 目录列举失败（假 WebDAV 返回 500）被 on_dir_error 捕获，不静默丢弃
  2. 失败目录持久化到 scan_failed，并在 /api/sources 的 DTO 里可观测
  3. 扫描差异报告（scan_diff）记录新增/更新/消失/未变与被删路径
  4. mode='failed' 只重扫失败目录：其余目录媒体不丢、失败目录修复后清空
  5. mode='failed' 无失败目录时回退全量（不报错）
  6. API 边界：mode=failed 合法（200）；mode=bogus 仍 400

自包含：同进程起假 WebDAV + 主服务，数据目录用独立临时目录。
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
os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-fail-test-")
os.environ.setdefault("WEBSUA_SCAN_RATE", "0")
os.environ.setdefault("WEBSUA_SCAN_RETRIES", "0")     # 500 立即报错，不重试
os.environ.setdefault("WEBSUA_SCAN_BACKOFF", "0")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fake_dav
from backend import db
from backend.server import serve

PORT = 8953
DAV_PORT = 8954

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
    data = b""
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
                               headers=headers)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def wait_task(tid, timeout=90):
    last = {}
    for _ in range(int(timeout / 0.2)):
        time.sleep(0.2)
        _, r = req(f"/api/tasks/{tid}")
        last = r.get("task") or {}
        if last.get("state") in ("done", "failed", "cancelled"):
            return last
    return last


# ---- 构造一棵小树：/ok 正常，/broken 故意列举失败 ----
fake_dav.build_fixture()
fake_dav.FILES.clear()
fake_dav.MTIMES.clear()
fake_dav.BROKEN_DIRS = set()


def put(path, size):
    mime = "image/jpeg" if path.endswith(".jpg") else "video/mp4"
    fake_dav.FILES[path] = (bytes(size), mime)


put("/ok/第1集.mp4", 1000)
put("/ok/第2集.mp4", 2000)
put("/broken/第A集.mp4", 3000)
put("/broken/sub/第B集.mp4", 4000)

dav = ThreadingHTTPServer(("127.0.0.1", DAV_PORT), fake_dav.Handler)
dav.daemon_threads = True
threading.Thread(target=dav.serve_forever, daemon=True).start()

app = serve("127.0.0.1", PORT)
time.sleep(0.5)

print("=" * 62)
print("失败目录重扫 + 扫描差异报告")
print("=" * 62)

for s in req("/api/sources")[1].get("sources", []):
    req(f"/api/sources/{s['id']}", "DELETE")

# ============ 1. 全量扫描：/broken 列举失败被捕获 ============
fake_dav.BROKEN_DIRS = {"/broken/"}
_, d = req("/api/sources", "POST", {
    "name": "失败源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/"})
sid = d["id"]
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "full"})
task = wait_task(t["task"]["id"])
check("全量扫描完成", task.get("state") == "done", f"state={task.get('state')}")
check("失败目录被记录（failed_dirs=1）", task.get("failed_dirs") == 1,
      f"failed_dirs={task.get('failed_dirs')}")
check("正常目录的 2 个文件入库", task.get("added") == 2, f"added={task.get('added')}")
check("失败目录下的文件未入库（不静默丢，但也不编造）",
      task.get("total") == 2, f"total={task.get('total')}")

# ============ 2. 失败目录在 DTO 中可观测 ============
_, d = req("/api/sources")
src = next(x for x in d["sources"] if x["id"] == sid)
check("源 DTO 含 failed_dirs 列表", len(src.get("failed_dirs") or []) == 1,
      json.dumps(src.get("failed_dirs"), ensure_ascii=False))
check("failed_dirs 含具体路径", src["failed_dirs"][0]["folder"] in ("/broken", "/broken/"),
      json.dumps(src["failed_dirs"], ensure_ascii=False))
check("源 DTO 含 last_diff 差异报告", src.get("last_diff") is not None,
      json.dumps(src.get("last_diff"), ensure_ascii=False))
check("last_diff 记录新增 2 未变 0",
      src["last_diff"]["added"] == 2 and src["last_diff"]["unchanged"] == 0,
      json.dumps(src["last_diff"], ensure_ascii=False))
check("last_diff 的 missing 为空列表（全量无消失）",
      src["last_diff"]["missing"] == [], json.dumps(src["last_diff"].get("missing")))

# 失败目录确实没进媒体表
_, m = req(f"/api/media?sources={sid}")
names = [x["name"] for x in m.get("media", [])]
check("媒体库不含 /broken 下文件", "第A集.mp4" not in names and "第B集.mp4" not in names,
      str(names))

# ============ 3. mode=failed 只重扫失败目录 ============
# 修好服务器：把 /broken 从坏目录集合移除
fake_dav.BROKEN_DIRS = set()
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "failed"})
task = wait_task(t["task"]["id"])
check("失败目录重扫完成", task.get("state") == "done", f"state={task.get('state')}")
check("任务如实记录为失败重扫模式", task.get("mode") == "failed", str(task.get("mode")))
check("本轮只发现 2 个文件（/broken 下）", task.get("found") == 2,
      f"found={task.get('found')}")
check("本轮新增 2（局部提交，不删其余）", task.get("added") == 2,
      f"added={task.get('added')}")
check("局部提交 removed=0（/ok 的文件不能丢）", task.get("removed") == 0,
      f"removed={task.get('removed')}")

# 失败目录修复后应从 scan_failed 清空
_, d = req("/api/sources")
src = next(x for x in d["sources"] if x["id"] == sid)
check("重扫成功后 failed_dirs 清空", len(src.get("failed_dirs") or []) == 0,
      json.dumps(src.get("failed_dirs"), ensure_ascii=False))
# 媒体总数补齐到 4
_, m = req(f"/api/media?sources={sid}")
check("媒体总数补齐为 4", m.get("total") == 4, f"total={m.get('total')}")
names = [x["name"] for x in m.get("media", [])]
check("第A集/第B集 已入库", "第A集.mp4" in names and "第B集.mp4" in names, str(names))

# ============ 4. 差异报告：远端消失 ============
del fake_dav.FILES["/ok/第1集.mp4"]
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "incremental"})
task = wait_task(t["task"]["id"])
check("增量扫描检测到 1 个消失", task.get("removed") == 1, f"removed={task.get('removed')}")
_, d = req("/api/sources")
src = next(x for x in d["sources"] if x["id"] == sid)
check("last_diff 记录被删路径（可观测，不静默丢弃）",
      src["last_diff"]["removed"] == 1
      and "/ok/第1集.mp4" in (src["last_diff"]["missing"] or []),
      json.dumps(src["last_diff"], ensure_ascii=False))

# ============ 5. mode=failed 无失败目录 → 回退全量不报错 ============
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "failed"})
task = wait_task(t["task"]["id"])
check("无失败目录时失败重扫回退全量仍成功", task.get("state") == "done",
      f"state={task.get('state')}")

# ============ 6. API 边界 ============
st, _ = req(f"/api/sources/{sid}/scan", "POST", {"mode": "bogus"})
check("非法 mode 仍 400", st == 400, f"status={st}")
st, _ = req(f"/api/sources/{sid}/scan", "POST", {"mode": "failed"})
check("mode=failed 合法返回 200", st == 200, f"status={st}")

# 删源要带走失败目录与差异报告，不留僵尸
req(f"/api/sources/{sid}", "DELETE")
check("删源后 scan_failed 清空", db.get_failed_dirs(sid) == [])

app.shutdown()
dav.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
