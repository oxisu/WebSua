#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把日志尾部转成一条 GitHub Actions annotation。

    python scripts/ci_diag.py run-all.log

为什么需要这个：Actions 的 job 日志要登录才能看，而 annotation 通过
check-runs API 是**公开可读**的。CI 红了却拿不到一行报错时，这个脚本能救命。

GitHub 的 annotation 消息是单行格式，换行要转义成 %0A、百分号要转义成 %25。
脚本用纯标准库、跨平台，避免在 Windows 的 Git Bash 里写 heredoc 又踩一次坑。
"""
from __future__ import annotations

import os
import sys

LIMIT = 3500          # 太长的 annotation 会被截断，留点余量

# 这个脚本专门在 Windows 上跑（CI 的 windows job），而英文区域的控制台是
# cp1252。这里直接按 UTF-8 输出：annotation 是给 GitHub 读的，UTF-8 才能让
# 中文套件名可读；只降级编码错误，绝不让「诊断自己」变成新的失败。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def pick(data: str) -> str:
    """优先给「失败汇总 + Traceback」，否则退回整个尾部。

    日志尾部往往只剩汇总列表，真正的原因（Traceback / 哪个用例 FAIL）在前面
    几十行。这里把关键段落挑出来，避免 annotation 只说「有失败」不说「哪失败」。
    """
    tail = data[-LIMIT:]
    keys = ("Traceback", "[FAIL]", "✗", "存在失败项", "主服务启动失败")
    hits = [ln for ln in tail.splitlines() if any(k in ln for k in keys)]
    if hits:
        return "\n".join(hits[-25:])
    return tail


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "run-all.log"
    title = sys.argv[2] if len(sys.argv) > 2 else "回归失败诊断"

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
    except OSError as e:
        # 日志都没生成（比如脚本根本没跑起来），也要让 CI 上看得见
        print(f"::warning title=诊断日志缺失::{os.path.basename(path)}: {e}")
        return 0

    tail = pick(data).replace("\r", "")
    esc = tail.replace("%", "%25").replace("\n", "%0A")
    print(f"::error title={title}（{os.path.basename(path)}）::{esc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
