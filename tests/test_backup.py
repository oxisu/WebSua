#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：配置导入导出 / 备份（v1.8.0）。

覆盖：
  1. 导出结构完整（sources / settings / favorites / progress / counts）
  2. 密码默认脱敏（只记 has_password，不含 password）；?passwords=1 才带上
  3. 导出带 Content-Disposition（浏览器直接下载成 .json）
  4. 跨实例恢复：删源后导入 → 源按 (base_url, root_path) 重建；
     收藏/进度按 (源身份, remote_path) 重新解析 media_id（未扫描时跳过并计数）
  5. 扫描后再次导入 → 收藏/进度真正恢复
  6. 幂等：重复导入不会重复加源/收藏
  7. 导入是合并语义：不会删除已有数据
  8. 非法 / 版本过高 / 非 WebSua 备份 → 400

自包含：同进程起主服务，数据目录独立；媒体用 db 直接写入模拟「已扫描」。
"""
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-backup-test-")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend import db          # noqa: E402
from backend.server import serve  # noqa: E402

PORT = 8957
BASE = f"http://127.0.0.1:{PORT}"
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
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(r, timeout=20) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw or b"{}"), dict(resp.headers), raw
            except json.JSONDecodeError:
                return resp.status, {}, dict(resp.headers), raw
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}"), dict(e.headers), b""
        except Exception:
            return e.code, {}, dict(e.headers), b""


def put_media(sid, path, size=1000):
    # partial=True：逐条模拟「扫描发现新文件」，不会把先前插入的媒体当成
    # 远端消失删掉（真实扫描每轮传的是完整清单，这里是一次一条）
    db.bulk_upsert_media(sid, [{
        "remote_path": path, "name": os.path.basename(path),
        "ext": os.path.splitext(path)[1], "kind": "video", "mime": "video/mp4",
        "size": size, "mtime": None, "folder": os.path.dirname(path) or "/",
    }], partial=True)
    return db.media_ids_by_path(sid, [path])[path]


print("=" * 62)
print("配置导入导出 / 备份")
print("=" * 62)

db.get_conn()
app = serve("127.0.0.1", PORT)

# ============ 1. 造数据 ============
st, d, _, _ = req("/api/sources", "POST", {
    "name": "备份源", "base_url": "http://dav.local/dav/", "root_path": "/v",
    "username": "u1", "password": "secret-pw", "tg_mode": True,
    "exclude_dirs": "临时", "auto_scan": True,
})
sid = d["id"]
mid = put_media(sid, "/v/第1集.mp4")
put_media(sid, "/v/第2集.mp4")
req(f"/api/media/{mid}/fav", "POST")
req("/api/progress", "POST", {"media_id": mid, "position": 42.5, "duration": 100})
req("/api/settings", "POST", {"autoNext": True, "pageFeed": 24, "pageLibrary": 48})

# ============ 2. 导出（默认脱敏）============
st, exp, hdrs, raw = req("/api/backup/export")
check("导出成功", st == 200 and exp.get("app") == "WebSua", f"status={st}")
check("导出带下载文件名",
      "attachment" in (hdrs.get("Content-Disposition") or ""),
      hdrs.get("Content-Disposition", ""))
check("导出包含结构字段",
      all(k in exp for k in ("version", "sources", "settings", "favorites",
                             "progress", "counts")),
      json.dumps(list(exp.keys()), ensure_ascii=False))
check("导出计数正确",
      exp["counts"] == {"sources": 1, "favorites": 1, "progress": 1},
      json.dumps(exp["counts"]))
src0 = exp["sources"][0]
check("默认不含明文密码", "password" not in src0 and src0.get("has_password") is True,
      json.dumps({k: src0.get(k) for k in ("has_password", "password")}, ensure_ascii=False))
check("未勾选时 includes_passwords=false", exp["includes_passwords"] is False)
check("源配置字段齐全",
      src0.get("root_path") == "/v" and src0.get("tg_mode") == 1
      and src0.get("exclude_dirs") == "临时",
      json.dumps(src0, ensure_ascii=False)[:120])
check("收藏/进度用稳定键而非 media_id",
      exp["favorites"][0].get("remote_path") == "/v/第1集.mp4"
      and "media_id" not in exp["favorites"][0]
      and exp["progress"][0].get("position") == 42.5,
      json.dumps(exp["favorites"][0], ensure_ascii=False))
check("设置随备份导出", exp["settings"].get("pageFeed") == 24,
      json.dumps(exp["settings"]))

# ============ 3. 导出（含密码）============
st, exp_pw, _, _ = req("/api/backup/export?passwords=1")
check("?passwords=1 带上明文密码",
      exp_pw["sources"][0].get("password") == "secret-pw"
      and exp_pw["includes_passwords"] is True,
      json.dumps({k: exp_pw["sources"][0].get(k) for k in ("password",)}, ensure_ascii=False))

# ============ 4. 删源 → 导入（媒体未扫描 → 跳过并计数）============
req(f"/api/sources/{sid}", "DELETE")
check("删源后数据清空",
      db.get_conn().execute("SELECT COUNT(*) c FROM media").fetchone()["c"] == 0)
st, r, _, _ = req("/api/backup/import", "POST", exp)
s = r.get("summary") or {}
check("导入成功", st == 200, f"status={st} {r}")
check("源按 (base_url, root_path) 重建", s.get("sources_added") == 1,
      json.dumps(s, ensure_ascii=False))
check("未设密码的源被标记待补", s.get("sources_need_password") == 1,
      json.dumps(s, ensure_ascii=False))
check("媒体未扫描 → 收藏/进度跳过并计数",
      s.get("favorites_restored") == 0 and s.get("favorites_skipped") == 1
      and s.get("progress_restored") == 0 and s.get("progress_skipped") == 1,
      json.dumps(s, ensure_ascii=False))
src = db.find_source_by_key("http://dav.local/dav", "/v")
check("重建的源保留配置（tg_mode/排除目录/账号）",
      src and src["tg_mode"] == 1 and src["exclude_dirs"] == "临时"
      and src["username"] == "u1", json.dumps({k: (src or {}).get(k) for k in
                                               ("tg_mode", "exclude_dirs", "username")},
                                              ensure_ascii=False))
check("导入不会用空密码覆盖已有密码", src and src["password"] == "",
      f"password={(src or {}).get('password')!r}")

# ============ 5. 扫描后再次导入 → 真正恢复 ============
sid2 = src["id"]
mid2 = put_media(sid2, "/v/第1集.mp4")
put_media(sid2, "/v/第2集.mp4")
st, r, _, _ = req("/api/backup/import", "POST", exp)
s = r.get("summary") or {}
check("媒体存在后收藏恢复", s.get("favorites_restored") == 1
      and db.is_favorite(mid2), json.dumps(s, ensure_ascii=False))
prog = db.get_progress(mid2) or {}
check("进度恢复且保留原数值", prog.get("position") == 42.5
      and prog.get("duration") == 100, json.dumps(prog))
check("重复导入是更新而非新增", s.get("sources_added") == 0
      and s.get("sources_updated") == 1, json.dumps(s, ensure_ascii=False))

# ============ 6. 幂等 ============
st, r, _, _ = req("/api/backup/import", "POST", exp)
s = r.get("summary") or {}
n_src = len(db.list_sources())
n_fav = db.get_conn().execute("SELECT COUNT(*) c FROM favorites").fetchone()["c"]
check("幂等：源不重复、收藏不重复",
      n_src == 1 and n_fav == 1 and s.get("favorites_restored") == 1,
      f"sources={n_src} favorites={n_fav}")

# ============ 7. 合并语义：不删除已有数据 ============
st, d2, _, _ = req("/api/sources", "POST", {
    "name": "后加源", "base_url": "http://other.local/dav", "root_path": "/",
})
sid3 = d2["id"]
st, r, _, _ = req("/api/backup/import", "POST", exp)
check("导入为合并语义（不删已有源）",
      len(db.list_sources()) == 2 and db.get_source(sid3) is not None,
      f"源数={len(db.list_sources())}")

# ============ 8. 含密码备份能恢复密码 ============
req(f"/api/sources/{sid2}", "DELETE")
st, r, _, _ = req("/api/backup/import", "POST", exp_pw)
src3 = db.find_source_by_key("http://dav.local/dav", "/v")
check("含密码备份导入后密码被恢复",
      src3 and src3["password"] == "secret-pw",
      f"password={(src3 or {}).get('password')!r}")

# ============ 9. 非法输入 ============
for bad, label in [
    ({}, "空对象缺少 version"),
    ({"version": 99, "sources": []}, "版本过高"),
    ({"version": 1, "sources": "not-a-list"}, "sources 不是数组"),
    ({"app": "OtherApp", "version": 1}, "非 WebSua 备份"),
]:
    st, r, _, _ = req("/api/backup/import", "POST", bad)
    check(f"拒绝无效备份：{label}", st == 400, f"status={st} body={r}")

app.shutdown()
print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
