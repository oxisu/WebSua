#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：局域网访问密码 / 令牌（v1.7.0）。

覆盖：
  1. 未设密码：API 正常放行（本机默认用法不该被挡）
  2. 设密码后：/api/* 全部 401（含媒体流 / 封面 / 字幕），静态资源仍可加载
  3. 登录：正确密码换到 token + Set-Cookie，Cookie / Bearer / ?token= 三种都通过
  4. 错误密码 401；连续失败触发限流锁定（429）
  5. 门禁状态接口语义正确（required / authed）
  6. 改密码会吊销旧 token；logout 吊销当前 token
  7. 密码不明文入库（只存 salt + 摘要）
  8. 非本机绑定未设密码 → serve() 直接拒绝启动
  9. 局域网绑定下不允许关闭门禁

自包含：同进程起主服务（假 WebDAV 非必需），数据目录用独立临时目录。
"""
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

# 必须在 import backend 之前设置（config 在导入时读环境变量）
os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-access-test-")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend import auth, db                      # noqa: E402
from backend.server import serve                  # noqa: E402

PORT = 8955
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


def req(path, method="GET", body=None, headers=None):
    data = b""
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=hdrs)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(r, timeout=20) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw or b"{}"), dict(resp.headers)
            except json.JSONDecodeError:
                return resp.status, {}, dict(resp.headers)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}"), dict(e.headers)
        except Exception:
            return e.code, {}, dict(e.headers)


print("=" * 62)
print("局域网访问密码 / 令牌")
print("=" * 62)

db.get_conn()
app = serve("127.0.0.1", PORT)

# ============ 1. 未设密码：全部放行 ============
st, d, _ = req("/api/sources")
check("未设密码时 API 放行", st == 200, f"status={st}")
st, d, _ = req("/api/auth/status")
check("门禁状态：未启用", d.get("required") is False and d.get("authed") is True,
      json.dumps(d, ensure_ascii=False))
st, _, _ = req("/api/health")
check("健康检查始终放行", st == 200, f"status={st}")

# ============ 2. 设密码后全部拦截 ============
auth.set_password("局域网口令123")
st, d, _ = req("/api/sources")
check("设密码后 API 返回 401", st == 401 and d.get("auth_required") is True,
      f"status={st} body={d}")
st, d, _ = req("/api/auth/status")
check("门禁状态：已启用且未登录",
      d.get("required") is True and d.get("authed") is False,
      json.dumps(d, ensure_ascii=False))
# 媒体流 / 封面 / 字幕同样受保护（不能只挡 JSON 接口）
for p in ("/api/media", "/api/stream/1", "/api/poster/1", "/api/subtitle/1",
          "/api/proxy/1", "/api/tasks"):
    st, _, _ = req(p)
    check(f"{p} 同样受门禁保护", st == 401, f"status={st}")
# 静态资源必须放行，否则登录界面本身渲染不出来
st, _, _ = req("/")
check("静态资源放行（登录界面要能加载）", st == 200, f"status={st}")

# ============ 3. 登录与三种凭据 ============
st, d, _ = req("/api/auth/login", "POST", {"password": "错误密码"})
check("错误密码返回 401", st == 401, f"status={st}")
st, d, h = req("/api/auth/login", "POST", {"password": "局域网口令123"})
check("正确密码登录成功", st == 200 and bool(d.get("token")), f"status={st}")
tok = d.get("token") or ""
cookie = h.get("Set-Cookie", "")
check("登录下发 HttpOnly Cookie",
      "websua_token=" in cookie and "HttpOnly" in cookie, cookie[:80])

st, _, _ = req("/api/sources", headers={"Cookie": cookie.split(";")[0]})
check("Cookie 凭据通过", st == 200, f"status={st}")
st, _, _ = req("/api/sources", headers={"Authorization": f"Bearer {tok}"})
check("Bearer 凭据通过", st == 200, f"status={st}")
st, _, _ = req(f"/api/sources?token={tok}")
check("?token= 凭据通过（外部播放器）", st == 200, f"status={st}")
st, _, _ = req("/api/sources")
check("无凭据仍被拒", st == 401, f"status={st}")
st, _, _ = req("/api/media", headers={"Cookie": cookie.split(";")[0]})
check("登录后媒体接口通过", st == 200, f"status={st}")

# ============ 4. 失败限流 ============
auth._fails.clear()
locked = False
for i in range(auth.ACCESS_MAX_FAILS + 1):
    st, _, _ = req("/api/auth/login", "POST", {"password": "肯定不对"})
    if st == 429:
        locked = True
        break
check("连续失败触发限流锁定（429）", locked, f"max={auth.ACCESS_MAX_FAILS}")
st, _, _ = req("/api/auth/login", "POST", {"password": "局域网口令123"})
check("锁定期内正确密码也被挡", st == 429, f"status={st}")
auth._fails.clear()   # 解锁，后续用例继续

# ============ 5. 改密 / 登出 ============
st, d, h2 = req("/api/auth/login", "POST", {"password": "局域网口令123"})
tok2 = d.get("token") or ""
ck2 = h2.get("Set-Cookie", "").split(";")[0]
st, _, _ = req("/api/auth/password", "POST", {"password": "新口令456"},
               headers={"Cookie": ck2})
check("已登录可修改密码", st == 200, f"status={st}")
st, _, _ = req("/api/sources", headers={"Cookie": ck2})
check("改密后旧 token 被吊销（强制重新登录）", st == 401, f"status={st}")
st, _, _ = req("/api/sources", headers={"Authorization": f"Bearer {tok}"})
check("改密吊销的是全部旧 token", st == 401, f"status={st}")

st, d, h3 = req("/api/auth/login", "POST", {"password": "新口令456"})
ck3 = h3.get("Set-Cookie", "").split(";")[0]
check("新密码可登录", st == 200, f"status={st}")
st, _, _ = req("/api/auth/logout", "POST", headers={"Cookie": ck3})
check("登出成功", st == 200, f"status={st}")
st, _, _ = req("/api/sources", headers={"Cookie": ck3})
check("登出后凭据失效", st == 401, f"status={st}")

# ============ 6. 密码不明文入库 ============
rec = db.get_setting("access") or {}
check("库中只存 salt + 摘要，无明文密码",
      "hash" in rec and "salt" in rec and "局域网口令123" not in json.dumps(rec)
      and "新口令456" not in json.dumps(rec), json.dumps(rec)[:120])

# ============ 7. 局域网绑定：不允许关闭门禁 ============
from backend import server as server_mod   # noqa: E402
# 上面登出已吊销 ck3，重新登录拿一份有效凭据
_, d, h4 = req("/api/auth/login", "POST", {"password": "新口令456"})
ck4 = h4.get("Set-Cookie", "").split(";")[0]
server_mod.BIND_HOST = "0.0.0.0"
st, _, _ = req("/api/auth/password", "POST", {"password": ""},
               headers={"Cookie": ck4})
check("局域网绑定下不允许关闭门禁", st == 400, f"status={st}")
server_mod.BIND_HOST = "127.0.0.1"
# 本机绑定下允许关闭（恢复无门禁状态，供下一个用例验证拒绝启动）
st, _, _ = req("/api/auth/password", "POST", {"password": ""},
               headers={"Cookie": ck4})
check("本机绑定下可以关闭门禁", st == 200, f"status={st}")

app.shutdown()

# ============ 8. 非本机绑定未设密码 → 拒绝启动 ============
auth.clear_password()
try:
    serve("0.0.0.0", 8956)
    check("非本机绑定未设密码时拒绝启动", False, "竟然启动成功了")
except RuntimeError as e:
    check("非本机绑定未设密码时拒绝启动", True, str(e).splitlines()[0][:60])

print()
print("=" * 62)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 62)
sys.exit(1 if FAIL else 0)
