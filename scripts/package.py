#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打一个可以直接解压就用的发布包。

    python scripts/package.py                # 输出 dist/WebSua-<版本>.zip
    python scripts/package.py --out 输出目录
    python scripts/package.py --name 自定义名字.zip

几个刻意的选择：

  · **条目排序 + 固定时间戳**：同一份源码打两次，zip 的 SHA256 必须一致。
    否则每次 tag 的校验和都不一样，「校验和」就失去意义了。
  · **带 tests/**：`python demo.py` 要用 tests/fake_dav.py 与样例视频，
    删掉就没法「一条命令试用」——这是发布包最重要的第一印象。
  · **不带 data/、data-demo/、data-test/、screenshots/**：都是本机运行时产物，
    尤其不能把别人的媒体库索引打进发布包。

零依赖，只用标准库；Windows 上也能跑。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

INCLUDE_DIRS = ("backend", "frontend", "docs", "tests")
INCLUDE_FILES = ("main.py", "demo.py", "README.md", "CHANGELOG.md",
                 "LICENSE", "package.json")
# 目录名命中即整棵跳过
SKIP_DIRS = {"__pycache__", "node_modules", ".git", ".github", ".workbuddy",
             "data", "data-test", "data-demo", "screenshots", "dist", ".venv", "venv"}
# 扩展名命中即跳过
SKIP_EXTS = {".pyc", ".pyo", ".db", ".db-wal", ".db-shm", ".log", ".tmp"}

# 固定时间戳（zip 格式最早只能到 1980），保证可复现
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def read_version() -> str:
    path = os.path.join(ROOT, "backend", "__init__.py")
    with open(path, "r", encoding="utf-8") as f:
        m = re.search(r'__version__\s*=\s*"([^"]+)"', f.read())
    if not m:
        raise SystemExit("读不到 backend/__init__.py 里的 __version__")
    return m.group(1)


def collect() -> list[tuple[str, str]]:
    """返回 [(磁盘绝对路径, 包内相对路径)]，已排序。"""
    out: list[tuple[str, str]] = []

    for name in INCLUDE_FILES:
        p = os.path.join(ROOT, name)
        if os.path.isfile(p):
            out.append((p, name))
        else:
            print(f"  ! 缺少 {name}（跳过）")

    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(n for n in dirnames if n not in SKIP_DIRS)
            for fn in sorted(filenames):
                if os.path.splitext(fn)[1].lower() in SKIP_EXTS:
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
                out.append((full, rel))

    out.sort(key=lambda x: x[1])
    return out


def build(out_dir: str, name: str | None = None) -> tuple[str, int, str]:
    version = read_version()
    name = name or f"WebSua-{version}.zip"
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, name)
    prefix = f"WebSua-{version}/"

    files = collect()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in files:
            info = zipfile.ZipInfo(prefix + rel, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16       # 普通文件权限
            with open(full, "rb") as f:
                z.writestr(info, f.read())

    digest = hashlib.sha256()
    with open(zip_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    hexdigest = digest.hexdigest()

    # 顺手写一份 sha256sum 格式的校验文件（sha256sum -c 可直接校验）
    with open(zip_path + ".sha256", "w", encoding="utf-8", newline="\n") as f:
        f.write(f"{hexdigest}  {name}\n")

    return zip_path, len(files), hexdigest


def main() -> int:
    ap = argparse.ArgumentParser(description="打 WebSua 发布包")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="输出目录（默认 dist/）")
    ap.add_argument("--name", default=None, help="zip 文件名（默认 WebSua-<版本>.zip）")
    args = ap.parse_args()

    zip_path, count, digest = build(args.out, args.name)
    size = os.path.getsize(zip_path)
    print(f"  ✓ {zip_path}")
    print(f"    版本 {read_version()} · {count} 个文件 · {size / 1024:.0f} KB")
    print(f"    sha256 {digest}")
    print(f"  ✓ {zip_path}.sha256")
    return 0


if __name__ == "__main__":
    sys.exit(main())
