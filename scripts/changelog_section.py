#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 CHANGELOG.md 抽出某个版本的段落，用作 GitHub Release 的说明。

    python scripts/changelog_section.py v1.11.0            # 打到标准输出
    python scripts/changelog_section.py 1.11.0 --out notes.md

版本号带不带 `v` 都认。找不到对应段落时返回码 2 —— 发布流程里宁可失败，
也不要用一段「空说明」把 Release 建出来。
"""
from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHANGELOG = os.path.join(ROOT, "CHANGELOG.md")


def extract(version: str, path: str = CHANGELOG) -> str:
    ver = version.strip().lstrip("vV")
    if not ver:
        raise ValueError("版本号为空")
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    # 标题形如：## [1.11.0] - 2026-10-27  或  ## [1.11.0]
    head = re.compile(r"^##\s+\[?" + re.escape(ver) + r"\]?")
    start = None
    for i, line in enumerate(lines):
        if head.match(line.strip()):
            start = i
            break
    if start is None:
        raise LookupError(f"CHANGELOG.md 里没有版本 {ver} 的段落")

    out = [lines[start]]
    for line in lines[start + 1:]:
        # 下一个二级标题即结束（### 属于本节内容，不截断）
        if line.startswith("## "):
            break
        out.append(line)

    text = "\n".join(out).strip()
    # 「新增 / 修复」这类小节标题降一级，嵌进 Release 正文更顺眼
    text = re.sub(r"^###\s+", "#### ", text, flags=re.MULTILINE)
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description="抽取 CHANGELOG 版本段落")
    ap.add_argument("version", help="版本号，如 v1.11.0 或 1.11.0")
    ap.add_argument("--out", default=None, help="写入文件（默认打到标准输出）")
    args = ap.parse_args()

    try:
        text = extract(args.version)
    except (LookupError, ValueError) as e:
        print(f"  ✗ {e}", file=sys.stderr)
        return 2

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text + "\n")
        print(f"  ✓ 已写入 {args.out}（{len(text.splitlines())} 行）")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
