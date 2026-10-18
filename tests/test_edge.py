"""边界场景测试：Basic 认证、忽略 Range 的坏服务器、远端文件消失。"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 项目根目录自动推导 —— 不写死任何本机绝对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

B = "http://127.0.0.1:8792"
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
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
    try:
        with op.open(r, timeout=40) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def raw(path, headers=None):
    r = urllib.request.Request(B + path, headers=headers or {})
    try:
        resp = op.open(r, timeout=40)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def clear_sources():
    _, d = req("/api/sources")
    for s in d["sources"]:
        req(f"/api/sources/{s['id']}", "DELETE")
    # 确认真的清空了 —— 上一轮残留会导致「地址重复」而建不出新源
    _, d2 = req("/api/sources")
    if d2["sources"]:
        print(f"  ! 警告：仍有 {len(d2['sources'])} 个源残留")


def new_source(**kw):
    """建源；若因地址重复失败（残留），先删同名旧源再建。"""
    st, d = req("/api/sources", "POST", kw)
    if st != 200:
        _, lst = req("/api/sources")
        for s in lst["sources"]:
            if s["base_url"] == kw["base_url"] and s["root_path"] == kw.get("root_path", "/"):
                req(f"/api/sources/{s['id']}", "DELETE")
        st, d = req("/api/sources", "POST", kw)
    assert "id" in d, f"建源失败: {st} {d}"
    return d["id"]


def wait_scan(sid, tries=40):
    _, t = req(f"/api/sources/{sid}/scan", "POST")
    tid = t["task"]["id"]
    for _ in range(tries):
        time.sleep(0.3)
        _, r = req(f"/api/tasks/{tid}")
        if r["task"]["state"] in ("done", "failed"):
            return r["task"]
    return {"state": "timeout"}


# ------------------------------------------------------------------
print("=" * 62)
print("场景 A：需要 Basic 认证的服务器")
print("=" * 62)
clear_sources()

# A1. 错误密码 → 应失败并给出可读原因
sid_bad = new_source(
    name="错密码", base_url="http://127.0.0.1:8898/dav",
    root_path="/", username="user", password="wrong",
)
t = wait_scan(sid_bad)
_, src = req("/api/sources")
err = next((s.get("last_error") for s in src["sources"] if s["id"] == sid_bad), "")
check("错误密码扫描失败", t["state"] == "failed", f"state={t['state']}")
check("记录了可读错误", "401" in (err or "") or "认证" in (err or "") or "HTTP" in (err or ""),
      (err or t.get("error", ""))[:60])

# A2. 正确密码 → 应成功
sid = new_source(
    name="对密码", base_url="http://127.0.0.1:8898/dav",
    root_path="/", username="user", password="pass",
)
t = wait_scan(sid)
check("正确密码扫描成功", t["state"] == "done",
      f"发现={t.get('found')} 错误={t.get('error', '')}")

_, m = req("/api/media?limit=50")
check("认证后可读到文件", m["total"] > 0, f"{m['total']} 个")

vid = next((x for x in m["media"] if x["kind"] == "video"), None)
if vid:
    st, h, body = raw(f"/api/stream/{vid['id']}")
    check("认证后能取流", st == 200 and len(body) == vid["size"],
          f"{st} 收到 {len(body)}/{vid['size']}")
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=0-99"})
    check("认证后 Range 正常", st == 206 and len(body) == 100, f"{st} {len(body)}B")

# A3. 密码不回传前端
_, src = req("/api/sources")
has_pw = any("password" in s and s["password"] for s in src["sources"])
check("密码未泄露给前端", not has_pw)
check("仅返回 has_password 标记",
      all("has_password" in s for s in src["sources"]),
      f"标记={[s.get('has_password') for s in src['sources']]}")

# ------------------------------------------------------------------
print()
print("=" * 62)
print("场景 B：远端文件被删除（索引还在）")
print("=" * 62)
if vid:
    # 用 WebDAV DELETE 让远端文件真的消失（索引还在）—— 模拟用户在网盘上删文件。
    # remote_path 不在对外 DTO 里（不暴露给前端），从隔离测试库直接读。
    import base64
    import os
    import sqlite3
    test_db = os.path.join(os.path.dirname(__file__), "..", "data-test", "library.db")
    conn = sqlite3.connect(test_db)
    rp = conn.execute("SELECT remote_path FROM media WHERE id = ?",
                      (vid["id"],)).fetchone()[0]
    conn.close()
    dav_url = f"http://127.0.0.1:8898/dav{urllib.parse.quote(rp)}"
    dav_req = urllib.request.Request(dav_url, method="DELETE", headers={
        "Authorization": "Basic " + base64.b64encode(b"user:pass").decode(),
    })
    try:
        with urllib.request.build_opener(
                urllib.request.ProxyHandler({})).open(dav_req, timeout=10) as resp:
            print(f"  [dav] DELETE {rp} → {resp.status}")
    except urllib.error.HTTPError as e:
        print(f"  [dav] DELETE 失败 → {e.code}")

    st, h, body = raw(f"/api/stream/{vid['id']}")
    ct = h.get("Content-Type", "")
    check("远端 404 返回 JSON 错误体", "json" in ct.lower(), f"Content-Type={ct}")
    try:
        payload = json.loads(body)
        check("错误信息为中文可读", "error" in payload and "删除" in payload["error"],
              payload.get("error", "")[:50])
    except Exception:
        check("错误信息为中文可读", False, f"非 JSON: {body[:60]}")

# ------------------------------------------------------------------
print()
print("=" * 62)
print("场景 C：认证服务器上的正常读取（密码透传到流）")
print("=" * 62)
clear_sources()
sid = new_source(name="认证读取", base_url="http://127.0.0.1:8898/dav",
                 root_path="/", username="user", password="pass")
t = wait_scan(sid)
check("认证服务器扫描成功", t["state"] == "done", f"发现={t.get('found')}")

_, m = req("/api/media?kinds=video&limit=5")
vid = next((x for x in m["media"] if x["kind"] == "video"), None)
if vid:
    total = vid["size"]
    st, h, body = raw(f"/api/stream/{vid['id']}")
    check("带认证取流成功", st == 200 and len(body) == total,
          f"{st} {len(body)}/{total}")
    st, h, body = raw(f"/api/stream/{vid['id']}", {"Range": "bytes=1000-1099"})
    check("带认证 Range 成功", st == 206 and len(body) == 100, f"{st} {len(body)}B")
    check("Content-Range 正确", h.get("Content-Range") == f"bytes 1000-1099/{total}",
          h.get("Content-Range"))

print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
