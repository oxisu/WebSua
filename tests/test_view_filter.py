#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""视图过滤：只看未看 / 只看有进度 / 只看已看完。"""
import os
import sys
import tempfile

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-pf-test-")

sys.path.insert(0, os.path.dirname(__file__))
import _console  # noqa: F401

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import backend.db as db

PASS = FAIL = 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


def _setup():
    """5 个媒体 + 3 条进度（未看/有进度/已看完）。"""
    sid = db.create_source({"name": "测试源", "base_url": "http://x/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    items = [
        {"name": f"v{i}.mp4", "remote_path": f"/m/v{i}.mp4", "folder": "/m",
         "size": 100 * i, "kind": "video", "mime": "video/mp4",
         "ext": ".mp4", "mtime": i}
        for i in range(1, 6)
    ]
    db.bulk_upsert_media(sid, items)
    # media_id 是自增 1..5（假设刚清过库）
    # 给 3 条加进度：1=已看完, 2=有进度, 3=未看（无记录）, 4=未看（position=0）, 5=有进度
    db.save_progress(1, 100, 100)   # finished
    db.save_progress(2, 50, 100)    # in_progress
    db.save_progress(5, 10, 100)    # in_progress
    # 3, 4 不设进度（= 未看）
    return sid


def test_progress_filter():
    print("  -- progress 过滤 --")
    _setup()

    # 全部
    _, total = db.query_media(limit=100)
    check("全部 5 条", total == 5, f"got {total}")

    # 未看：3 和 4
    rows, total = db.query_media(progress_filter="unwatched", limit=100)
    check("未看 2 条", total == 2, f"got {total}")
    names = {r["name"] for r in rows}
    check("未看包含 v3/v4", names == {"v3.mp4", "v4.mp4"}, str(names))

    # 有进度：2 和 5
    rows, total = db.query_media(progress_filter="in_progress", limit=100)
    check("有进度 2 条", total == 2, f"got {total}")
    names = {r["name"] for r in rows}
    check("有进度包含 v2/v5", names == {"v2.mp4", "v5.mp4"}, str(names))

    # 已看完：1
    rows, total = db.query_media(progress_filter="finished", limit=100)
    check("已看完 1 条", total == 1, f"got {total}")
    check("已看完是 v1", rows[0]["name"] == "v1.mp4")

    # 与 fav 组合
    db.toggle_favorite(2)
    rows, total = db.query_media(progress_filter="in_progress", favorite_only=True, limit=100)
    check("有进度+收藏 1 条", total == 1, f"got {total}")
    check("是 v2", rows[0]["name"] == "v2.mp4")


if __name__ == "__main__":
    print("test_view_filter.py")
    test_progress_filter()
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    sys.exit(1 if FAIL else 0)
