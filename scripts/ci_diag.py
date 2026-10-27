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

# 这个脚本专门在 Windows 上跑（CI 的 windows job），而英文区域的控制台是
# cp1252。这里直接按 UTF-8 输出：annotation 是给 GitHub 读的，UTF-8 才能让
# 中文套件名可读；只降级编码错误，绝不让「诊断自己」变成新的失败。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def pick(data: str) -> str:
    """拼一条「能直接看懂」的诊断：先给失败汇总，再给失败用例详情。

    日志尾部往往只剩一堆 [PASS]，真正有用的「哪套失败 / 为什么失败」被挤掉；
    annotation 又有长度上限，所以这里主动挑行并控制篇幅。
    """
    lines = [ln.rstrip() for ln in data.splitlines()]
    summary = [ln for ln in lines
               if ln.strip().startswith(("✗ 失败", "✓ 通过", "全部通过", "存在失败项"))]
    details = [ln for ln in lines if ln.strip().startswith(("[FAIL]", "Traceback"))][:20]

    out = []
    if summary:
        out.append("【套件汇总】")
        out.extend(summary[-13:])
    if details:
        out.append("【失败详情】")
        out.extend(details)
    if not out:
        out.append("【日志尾部】")
        out.append(data[-1200:])
    return "\n".join(out)


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
