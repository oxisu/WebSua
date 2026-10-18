#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：增量扫描 + 断点续扫（v1.5.0）。

覆盖：
  1. 增量：未变项（size/mtime/关联全部一致）不写库，indexed_at 不刷新
  2. 变更项：size 变了 → 更新；只有 mtime 变了 → 也更新（mtime 参与签名）
  3. 新增 / 远端消失（移除）
  4. 断点续扫：从 scan_state 的目录栈接着遍历，已暂存的不重来
  5. 取消保留进度：cancelled 任务留下可继续的断点，续扫后总量补齐
  6. 过期断点（root 变了）忽略重扫；DELETE 放弃断点
  7. API 边界：mode 非法 400、放弃无断点 409、scan-state 源不存在 404

自包含：同进程起假 WebDAV + 主服务，数据目录用独立临时目录。
fake_dav 支持按文件覆盖 mtime（MTIMES），用来验证「同大小但改过」。
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
os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-inc-test-")
os.environ.setdefault("WEBSUA_SCAN_RATE", "0")     # 取消竞态窗口处再临时放慢
os.environ.setdefault("WEBSUA_SCAN_RETRIES", "0")
os.environ.setdefault("WEBSUA_SCAN_BACKOFF", "0")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fake_dav
import backend.webdav as webdav_mod
from backend import db
from backend.config import SCAN_MAX_DEPTH
from backend.server import serve

PORT = 8951
DAV_PORT = 8952

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
    """轮询直到任务终结，返回任务 dict。"""
    last = {}
    for _ in range(int(timeout / 0.2)):
        time.sleep(0.2)
        _, r = req(f"/api/tasks/{tid}")
        last = r.get("task") or {}
        if last.get("state") in ("done", "failed", "cancelled"):
            return last
    return last


# ---- 构造确定的小树 + 一棵用于取消竞态的大树 ----
fake_dav.build_fixture()
fake_dav.FILES.clear()
fake_dav.MTIMES.clear()


def put(path, size):
    mime = "image/jpeg" if path.endswith(".jpg") else "video/mp4"
    fake_dav.FILES[path] = (bytes(size), mime)


put("/inc/第1集.mp4", 1000)
put("/inc/第2集.mp4", 2000)
put("/inc/第3集.mp4", 3000)
put("/inc/封面.jpg", 4000)
put("/inc/sub/第4集.mp4", 5000)
for i in range(1, 25):
    put(f"/批量/目录{i:02d}/第{i}集.webm", 50_000)

dav = ThreadingHTTPServer(("127.0.0.1", DAV_PORT), fake_dav.Handler)
dav.daemon_threads = True
threading.Thread(target=dav.serve_forever, daemon=True).start()

app = serve("127.0.0.1", PORT)
time.sleep(0.5)

print("=" * 62)
print("增量扫描与断点续扫")
print("=" * 62)

_, d = req("/api/sources")
for s in d.get("sources", []):
    req(f"/api/sources/{s['id']}", "DELETE")

# ============ 1. 全量扫描基线 ============
st, d = req("/api/sources", "POST", {
    "name": "增量源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/inc"})
sid = d["id"]
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "full"})
task = wait_task(t["task"]["id"])
check("首次全量扫描成功", task.get("state") == "done", f"state={task.get('state')}")
check("全量新增 5 个媒体（4 文件 + 子目录 1 个，.jpg 也入库）",
      task.get("added") == 5, f"added={task.get('added')}")
check("全量任务统计三件套齐全",
      task.get("unchanged") == 0 and task.get("updated") == 0 and task.get("removed") == 0,
      json.dumps({k: task.get(k) for k in ("added", "updated", "removed", "unchanged")}))

before = {r["remote_path"]: r["indexed_at"] for r in db.get_conn().execute(
    "SELECT remote_path, indexed_at FROM media WHERE source_id = ?", (sid,))}
check("基线索引 5 条", len(before) == 5, str(sorted(before)))

# ============ 2. 无变化增量：全部跳过 ============
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "incremental"})
task = wait_task(t["task"]["id"])
check("无变化增量扫描成功", task.get("state") == "done", f"state={task.get('state')}")
check("未变项全部跳过（added=updated=removed=0）",
      task.get("added") == 0 and task.get("updated") == 0 and task.get("removed") == 0,
      json.dumps({k: task.get(k) for k in ("added", "updated", "removed")}))
check("未变计数 = 5", task.get("unchanged") == 5, f"unchanged={task.get('unchanged')}")

after = {r["remote_path"]: r["indexed_at"] for r in db.get_conn().execute(
    "SELECT remote_path, indexed_at FROM media WHERE source_id = ?", (sid,))}
check("indexed_at 未被刷新（否则「最新」排序失去意义）", before == after,
      f"{before} -> {after}")

# ============ 3. size 变化 → 更新 ============
put("/inc/第2集.mp4", 2500)
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "incremental"})
task = wait_task(t["task"]["id"])
check("size 变化的条目被更新", task.get("updated") == 1, f"updated={task.get('updated')}")
check("其余仍未变", task.get("unchanged") == 4, f"unchanged={task.get('unchanged')}")
row = db.get_conn().execute(
    "SELECT size FROM media WHERE source_id = ? AND remote_path = ?",
    (sid, "/inc/第2集.mp4")).fetchone()
check("库里 size 已同步", row and row["size"] == 2500, str(row and row["size"]))

# ============ 4. 只有 mtime 变化 → 也更新 ============
fake_dav.MTIMES["/inc/第3集.mp4"] = "Tue, 04 Oct 2026 08:00:00 GMT"
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "incremental"})
task = wait_task(t["task"]["id"])
check("同大小但 mtime 变了也算变更（mtime 参与签名）",
      task.get("updated") == 1, f"updated={task.get('updated')}")
fake_dav.MTIMES.pop("/inc/第3集.mp4")

# ============ 5. 新增 / 移除 ============
put("/inc/第5集.mp4", 6000)
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "incremental"})
task = wait_task(t["task"]["id"])
check("新文件被新增", task.get("added") == 1, f"added={task.get('added')}")
check("新增后总量 6", task.get("total") == 6, f"total={task.get('total')}")

del fake_dav.FILES["/inc/封面.jpg"]
_, t = req(f"/api/sources/{sid}/scan", "POST", {"mode": "incremental"})
task = wait_task(t["task"]["id"])
check("远端消失的条目被移除", task.get("removed") == 1, f"removed={task.get('removed')}")
check("移除后总量 5", task.get("total") == 5, f"total={task.get('total')}")
_, d = req("/api/media?sources=" + str(sid))
check("媒体库确实查不到已删除文件",
      all(m["name"] != "封面.jpg" for m in d.get("media", [])), "")

# ============ 6. 断点续扫（确定性：直接构造现场） ============
# 先释放 /inc 的占用（同 base_url + root_path 不允许建两个源）
req(f"/api/sources/{sid}", "DELETE")
st, d = req("/api/sources", "POST", {
    "name": "续扫源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/inc"})
sid2 = d["id"]
# 现场：/inc 已遍历完（4 个文件已暂存），还剩 /inc/sub 没下钻
db.stage_clear(sid2)
db.stage_put_many(sid2, [
    {"remote_path": "/inc/第1集.mp4", "name": "第1集.mp4", "ext": ".mp4",
     "kind": "video", "mime": "video/mp4", "size": 1000, "mtime": None, "folder": "/inc"},
    {"remote_path": "/inc/第2集.mp4", "name": "第2集.mp4", "ext": ".mp4",
     "kind": "video", "mime": "video/mp4", "size": 2000, "mtime": None, "folder": "/inc"},
    {"remote_path": "/inc/第3集.mp4", "name": "第3集.mp4", "ext": ".mp4",
     "kind": "video", "mime": "video/mp4", "size": 3000, "mtime": None, "folder": "/inc"},
    {"remote_path": "/inc/第5集.mp4", "name": "第5集.mp4", "ext": ".mp4",
     "kind": "video", "mime": "video/mp4", "size": 6000, "mtime": None, "folder": "/inc"},
])
db.save_scan_state(sid2, "/inc", SCAN_MAX_DEPTH, "", [("/inc/sub", 1)], ["/inc"], "full")
check("续扫前有断点可查", db.has_resumable_scan(sid2) is True)
_, st_d = req(f"/api/sources/{sid2}/scan-state")
check("scan-state 接口报告可续扫",
      st_d.get("resumable") is True and st_d["state"]["staged_files"] == 4,
      json.dumps(st_d.get("state", {}), ensure_ascii=False))

_, t = req(f"/api/sources/{sid2}/scan", "POST", {"resume": True})
task = wait_task(t["task"]["id"])
check("续扫任务完成", task.get("state") == "done", f"state={task.get('state')}")
check("任务如实记录为续扫", task.get("resume") is True, str(task.get("resume")))
check("续扫总量 = 暂存 4 + 新遍历 1", task.get("total") == 5, f"total={task.get('total')}")
check("续扫入库 5 条（4 条来自暂存 + 1 条新遍历）",
      task.get("added") == 5, f"added={task.get('added')}")
check("续扫完成后断点被清理", db.has_resumable_scan(sid2) is False)
_, st_d = req(f"/api/sources/{sid2}/scan-state")
check("scan-state 续扫后报告无可续扫", st_d.get("resumable") is False)

# ============ 7. 取消 → 保留进度 → 续扫补齐 ============
st, d = req("/api/sources", "POST", {
    "name": "参考源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/"})
sid_ref = d["id"]
_, t = req(f"/api/sources/{sid_ref}/scan", "POST", {"mode": "full"})
ref_task = wait_task(t["task"]["id"])
expected_total = ref_task.get("total") or 0
check("参考源全量扫描得到总量", expected_total >= 25, f"total={expected_total}")
# 参考源只是用来拿期望值，删掉把 "/" 根路径腾给取消源
req(f"/api/sources/{sid_ref}", "DELETE")

st, d = req("/api/sources", "POST", {
    "name": "取消源", "base_url": f"http://127.0.0.1:{DAV_PORT}/dav", "root_path": "/"})
sid3 = d["id"]
# 限流放慢到 30ms/目录，25+ 个目录约 1 秒，留出取消窗口
old_rate = webdav_mod.SCAN_RATE_LIMIT
webdav_mod.SCAN_RATE_LIMIT = 0.03
_, t = req(f"/api/sources/{sid3}/scan", "POST", {"mode": "full"})
tid = t["task"]["id"]
cancelled_task = None
for _ in range(200):
    time.sleep(0.05)
    _, r = req(f"/api/tasks/{tid}")
    tk = r.get("task") or {}
    # 等到「至少发现 1 个文件」再取消：保证暂存表非空，
    # 只等目录数的话取消可能抢在第一个文件产出前，stage 自然是空的
    if tk.get("state") == "running" and (tk.get("found") or 0) >= 1:
        req(f"/api/sources/{sid3}/scan/cancel", "POST")
        cancelled_task = wait_task(tid, 20)
        break
    if tk.get("state") in ("done", "failed", "cancelled"):
        cancelled_task = tk
        break
webdav_mod.SCAN_RATE_LIMIT = old_rate
check("扫描被中途取消", cancelled_task and cancelled_task.get("state") == "cancelled",
      f"state={(cancelled_task or {}).get('state')}")
check("取消的任务标记为可续扫", cancelled_task and cancelled_task.get("resumable") is True)
_, st_d = req(f"/api/sources/{sid3}/scan-state")
check("取消后断点可查（暂存了已发现的文件）",
      st_d.get("resumable") is True and st_d["state"]["staged_files"] > 0,
      json.dumps(st_d.get("state", {}), ensure_ascii=False))
_, d = req("/api/sources")
s3 = next((x for x in d.get("sources", []) if x["id"] == sid3), {})
check("源列表标记 resumable（前端据此显示「继续扫描」）", s3.get("resumable") is True)

_, t = req(f"/api/sources/{sid3}/scan", "POST", {"resume": True})
task = wait_task(t["task"]["id"])
check("续扫后扫描完成", task.get("state") == "done", f"state={task.get('state')}")
check("续扫补齐后总量与参考源一致",
      task.get("total") == expected_total, f"total={task.get('total')} expected={expected_total}")
_, st_d = req(f"/api/sources/{sid3}/scan-state")
check("续扫完成后断点清除", st_d.get("resumable") is False)

# ============ 8. 过期断点 + 放弃 ============
db.save_scan_state(sid2, "/不存在的目录", SCAN_MAX_DEPTH, "", [("/x", 1)], [], "full")
_, t = req(f"/api/sources/{sid2}/scan", "POST", {"resume": True})
task = wait_task(t["task"]["id"])
check("root 变了的旧断点被忽略（回退全量重扫）",
      task.get("state") == "done" and task.get("resume") is False,
      f"state={task.get('state')} resume={task.get('resume')}")
check("回退重扫后总量正确", task.get("total") == 5, f"total={task.get('total')}")

db.save_scan_state(sid2, "/inc", SCAN_MAX_DEPTH, "", [("/inc/sub", 1)], ["/inc"], "full")
db.stage_put_many(sid2, [
    {"remote_path": "/inc/第1集.mp4", "name": "第1集.mp4", "ext": ".mp4",
     "kind": "video", "mime": "video/mp4", "size": 1000, "mtime": None, "folder": "/inc"}])
st, _ = req(f"/api/sources/{sid2}/scan-state", "DELETE")
check("放弃断点返回 200", st == 200, f"status={st}")
_, st_d = req(f"/api/sources/{sid2}/scan-state")
check("放弃后无可续扫断点", st_d.get("resumable") is False)
check("放弃后暂存表已清空", db.stage_count(sid2) == 0, str(db.stage_count(sid2)))
st, _ = req(f"/api/sources/{sid2}/scan-state", "DELETE")
check("没有断点时放弃返回 409", st == 409, f"status={st}")

# ============ 9. API 边界 ============
st, _ = req(f"/api/sources/{sid3}/scan", "POST", {"mode": "bogus"})
check("非法 mode → 400", st == 400, f"status={st}")
st, _ = req("/api/sources/999999/scan-state")
check("scan-state 源不存在 → 404", st == 404, f"status={st}")
st, _ = req(f"/api/sources/{sid3}/scan-state")
check("正常源的 scan-state 返回 200", st == 200, f"status={st}")

# 删除源要带走断点/暂存，不留僵尸
db.save_scan_state(sid2, "/inc", SCAN_MAX_DEPTH, "", [("/inc/sub", 1)], ["/inc"], "full")
req(f"/api/sources/{sid2}", "DELETE")
check("删源后断点与暂存一起清掉", db.has_resumable_scan(sid2) is False)

app.shutdown()
dav.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
