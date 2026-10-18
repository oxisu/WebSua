"""访问门禁：单用户访问密码 + 登录令牌。

只做「一个密码挡住局域网」这一件事 —— 不做多用户、不做权限分级。
设计取舍：

- **密码不明文存库**：pbkdf2-hmac-sha256 + 随机 salt，只存 salt 与摘要。
  数据库被拷走也拿不到原密码（自助场景常见的「db 随手备份」风险）。
- **令牌签名在内存**：不落库。进程重启即全部失效 —— 家用场景可接受，
  且天然满足「重启等于强制下线所有设备」。
- **三种携带方式**：Cookie（浏览器自动带，媒体流 / 封面不需要改 URL）、
  `Authorization: Bearer`（脚本）、`?token=`（VLC / 外部播放器这类
  没法带请求头的客户端）。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from typing import Any

from . import db
from .config import (ACCESS_TOKEN_TTL, ACCESS_PBKDF2_ITERS,
                     ACCESS_MAX_FAILS, ACCESS_FAIL_LOCKOUT)

META_KEY = "access"
COOKIE_NAME = "websua_token"

_lock = threading.RLock()
# token -> 过期时间戳（内存态，重启即失效）
_tokens: dict[str, float] = {}
# 来源 IP -> [连续失败次数, 解锁时间戳]
_fails: dict[str, list] = {}

_LOOPBACK = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


def is_loopback(host: str) -> bool:
    """是否只监听本机。非本机绑定必须开启门禁。"""
    return (host or "").strip().lower() in _LOOPBACK


# ---------------- 密码 ----------------

def _hash(pw: str, salt: bytes, iters: int) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iters).hex()


def set_password(pw: str) -> None:
    """设置 / 修改访问密码（存 salt + 摘要，不存明文）。"""
    pw = pw or ""
    if not pw:
        clear_password()
        return
    salt = secrets.token_bytes(16)
    rec = {
        "salt": salt.hex(),
        "hash": _hash(pw, salt, ACCESS_PBKDF2_ITERS),
        "iters": ACCESS_PBKDF2_ITERS,
        "updated_at": int(time.time()),
    }
    db.set_setting(META_KEY, rec)
    # 改密即踢掉所有旧会话：旧 token 是旧密码签出来的，不该继续有效
    with _lock:
        _tokens.clear()


def clear_password() -> None:
    """关闭门禁（删除密码记录与所有已签发令牌）。"""
    db.set_setting(META_KEY, {})
    with _lock:
        _tokens.clear()


def has_password() -> bool:
    rec = db.get_setting(META_KEY) or {}
    return bool(isinstance(rec, dict) and rec.get("hash"))


def verify_password(pw: str) -> bool:
    """校验密码。用 compare_digest 做常量时间比较，防时序侧信道。"""
    rec = db.get_setting(META_KEY) or {}
    if not isinstance(rec, dict) or not rec.get("hash"):
        return False
    try:
        salt = bytes.fromhex(rec.get("salt") or "")
        iters = int(rec.get("iters") or ACCESS_PBKDF2_ITERS)
    except (ValueError, TypeError):
        return False
    calc = _hash(pw or "", salt, iters)
    return hmac.compare_digest(calc, str(rec["hash"]))


# ---------------- 令牌 ----------------

def issue_token() -> str:
    tok = secrets.token_urlsafe(32)
    with _lock:
        _tokens[tok] = time.time() + ACCESS_TOKEN_TTL
    return tok


def check_token(tok: str) -> bool:
    if not tok:
        return False
    with _lock:
        exp = _tokens.get(tok)
        if exp is None:
            return False
        if exp <= time.time():
            del _tokens[tok]
            return False
    return True


def revoke_token(tok: str) -> None:
    if tok:
        with _lock:
            _tokens.pop(tok, None)


def token_from_cookie(cookie_header: str) -> str:
    """从 Cookie 头里取 token（不引入 http.cookies，手写足够）。"""
    for part in (cookie_header or "").split(";"):
        kv = part.strip().split("=", 1)
        if len(kv) == 2 and kv[0].strip() == COOKIE_NAME:
            return kv[1].strip()
    return ""


def cookie_header(tok: str, max_age: int | None = None) -> str:
    age = max_age if max_age is not None else ACCESS_TOKEN_TTL
    return (f"{COOKIE_NAME}={tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}")


# ---------------- 登录失败限流 ----------------

def locked_out(source: str) -> int:
    """返回还需等待的秒数（0 = 未锁定）。"""
    with _lock:
        rec = _fails.get(source or "?")
        if not rec or not rec[1]:
            return 0
        left = int(rec[1] - time.time())
        return left if left > 0 else 0


def note_fail(source: str) -> int:
    """记录一次失败，返回还需等待的秒数（0 = 还没到阈值）。

    rec = [连续失败次数, 锁定截止时间戳]；截止为 0 表示当前未锁定。
    **坑**：不要拿「创建时间」当截止时间戳比较，否则每次调用都会因为
    `rec[1] <= now` 成立而把计数清零，限流永远触发不了。
    """
    now = time.time()
    src = source or "?"
    with _lock:
        rec = _fails.get(src)
        if rec is None or (rec[1] and rec[1] <= now):
            rec = [0, 0]        # 首次失败，或上一次锁定已过期
            _fails[src] = rec
        rec[0] += 1
        if rec[0] >= ACCESS_MAX_FAILS:
            rec[1] = now + ACCESS_FAIL_LOCKOUT
            return ACCESS_FAIL_LOCKOUT
    return 0


def note_success(source: str) -> None:
    with _lock:
        _fails.pop(source or "?", None)


def active_tokens() -> int:
    with _lock:
        return len(_tokens)


def info() -> dict[str, Any]:
    return {
        "enabled": has_password(),
        "updated_at": (db.get_setting(META_KEY) or {}).get("updated_at")
        if isinstance(db.get_setting(META_KEY), dict) else None,
        "tokens": active_tokens(),
        "ttl": ACCESS_TOKEN_TTL,
    }
