"""场景：服务器忽略 Range（返回 200 全量）—— 验证本地字节裁剪。

自己起一个 norange 模式的假服务器，不依赖外部进程。
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

# 项目根目录自动推导 —— 不写死任何本机绝对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fake_dav

B = "http://127.0.0.1:8792"
PORT = 8901
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
    r = urllib.request.Request(B + path, data=data, method=method,
                               headers={"Content-Type": "application/json"} if data else {})
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(r, timeout=40) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def raw(path, headers=None):
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    r = urllib.request.Request(B + path, headers=headers or {})
    try:
        resp = op.open(r, timeout=40)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


# ---- 起一个忽略 Range 的服务器 ----
fake_dav.REQUIRE_AUTH = None
fake_dav.IGNORE_RANGE = True      # 关键：让它无视 Range 永远回 200 全量
fake_dav.build_fixture()
srv = ThreadingHTTPServer(("127.0.0.1", PORT), fake_dav.Handler)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(0.5)

print("=" * 62)
print("服务器忽略 Range 时的本地裁剪")
print("=" * 62)

# 先确认服务器确实无视 Range（同进程直接从文件表取一个真实路径）
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_any = next(iter(fake_dav.FILES))
rq = urllib.request.Request("http://127.0.0.1:" + str(PORT) + "/dav" + urllib.parse.quote(_any),
                            headers={"Range": "bytes=0-99"})
with op.open(rq, timeout=10) as resp:
    check("服务器确实忽略 Range（回 200）", resp.status == 200, f"status={resp.status}")

# 建源
_, d = req("/api/sources")
for s in d["sources"]:
    req(f"/api/sources/{s['id']}", "DELETE")

st, d = req("/api/sources", "POST", {
    "name": "无Range服务器", "base_url": f"http://127.0.0.1:{PORT}/dav", "root_path": "/"})
sid = d["id"]
_, t = req(f"/api/sources/{sid}/scan", "POST")
tid = t["task"]["id"]
for _ in range(40):
    time.sleep(0.3)
    _, r = req(f"/api/tasks/{tid}")
    if r["task"]["state"] in ("done", "failed"):
        break
task = r["task"]
check("扫描成功", task["state"] == "done", f"发现={task.get('found')}")

_, m = req("/api/media?kinds=video&limit=5")
vid = next((x for x in m["media"] if x["kind"] == "video"), None)
check("找到视频条目", vid is not None, vid["name"] if vid else "")

if vid:
    total = vid["size"]
    print(f"  文件大小 = {total}")

    # 全量作为基准
    st, h, full = raw(f"/api/stream/{vid['id']}")
    check("全量读取正确", st == 200 and len(full) == total, f"{len(full)}/{total}")

    # 首段
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=0-1023"})
    check("首段返回 206（上游回 200，本地裁剪）", st == 206, f"状态={st}")
    check("首段长度正确", len(body) == 1024, f"收到 {len(body)}")
    check("首段 Content-Range 正确", h.get("Content-Range") == f"bytes 0-1023/{total}",
          h.get("Content-Range"))
    check("首段 Content-Length 正确", h.get("Content-Length") == "1024", h.get("Content-Length"))
    check("首段内容与全量一致", full[:1024] == body)

    # 中段
    mid = total // 2
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": f"bytes={mid}-"})
    check("中段长度正确", st == 206 and len(body) == total - mid,
          f"收到 {len(body)}，期望 {total - mid}")
    check("中段 Content-Range 正确", h.get("Content-Range") == f"bytes {mid}-{total-1}/{total}",
          h.get("Content-Range"))
    check("中段内容一致", full[mid:mid + 2000] == body[:2000])

    # 尾段
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=-500"})
    check("尾段（后500字节）正确", st == 206 and len(body) == 500, f"收到 {len(body)}")
    check("尾段内容一致", full[-500:] == body)

    # 精确区间
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=1000-1999"})
    check("精确区间正确", st == 206 and len(body) == 1000, f"收到 {len(body)}")
    check("精确区间内容一致", full[1000:2000] == body)

    # 连续拖动（模拟用户反复 seek）—— 偏移按文件大小取比例，不硬编码绝对值
    ok = True
    for frac in (0, 0.2, 0.5, 0.8, 0.95):
        off = int(total * frac)
        st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": f"bytes={off}-{off+999}"})
        if not (st == 206 and len(body) == 1000 and full[off:off+1000] == body):
            ok = False
            print(f"      偏移 {off} 失败: {st} {len(body)}B")
    check("连续拖动 5 次全部正确", ok)

srv.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
