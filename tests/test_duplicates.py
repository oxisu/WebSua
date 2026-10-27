#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重复文件检测：按 (文件名, 大小) 轻量分组，不上全量哈希。"""
import os
import sys
import tempfile

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-dup-test-")

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


def _clean():
    conn = db.get_conn()
    conn.execute("DELETE FROM media")
    conn.execute("DELETE FROM sources")
    conn.execute("DELETE FROM favorites")
    conn.execute("DELETE FROM progress")
    conn.commit()


def _mk(sid, name, folder, size, path=None):
    return {"name": name, "remote_path": path or f"{folder}/{name}",
            "folder": folder, "size": size, "kind": "video",
            "mime": "video/mp4", "ext": ".mp4", "mtime": 1}


def _setup():
    sid = db.create_source({"name": "T", "base_url": "http://x/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    # a.mp4 3 份（同大小）→ 重复
    # b.mp4 2 份 → 重复
    # c.mp4 1 份 → 不重复
    # d.mp4 2 份但大小不同 → 不算重复
    items = [
        _mk(sid, "a.mp4", "/x", 1000, "/x/a.mp4"),
        _mk(sid, "a.mp4", "/y", 1000, "/y/a.mp4"),
        _mk(sid, "a.mp4", "/z", 1000, "/z/a.mp4"),
        _mk(sid, "b.mp4", "/x", 2000, "/x/b.mp4"),
        _mk(sid, "b.mp4", "/y", 2000, "/y/b.mp4"),
        _mk(sid, "c.mp4", "/x", 3000, "/x/c.mp4"),
        _mk(sid, "d.mp4", "/x", 4000, "/x/d.mp4"),
        _mk(sid, "d.mp4", "/y", 4500, "/y/d.mp4"),   # 大小不同
    ]
    db.bulk_upsert_media(sid, items)
    return sid


def test_basic():
    print("  -- 基础分组 --")
    _clean()
    _setup()
    groups = db.find_duplicates()
    names = {g["name"]: g for g in groups}
    check("2 个重复组", len(groups) == 2, f"got {len(groups)} -> {list(names)}")
    check("a.mp4 是重复组", "a.mp4" in names)
    check("b.mp4 是重复组", "b.mp4" in names)
    check("c.mp4 不算重复", "c.mp4" not in names)
    check("d.mp4 大小不同不算重复", "d.mp4" not in names)

    a = names["a.mp4"]
    check("a.mp4 count=3", a["count"] == 3, f"got {a['count']}")
    check("a.mp4 items 3 条", len(a["items"]) == 3)
    check("a.mp4 total_size=3000", a["total_size"] == 3000, f"got {a['total_size']}")


def test_wasted():
    print("  -- 浪费空间计算 --")
    _clean()
    _setup()
    groups = db.find_duplicates()
    # a: 3×1000 浪费 2000；b: 2×2000 浪费 2000 → 共 4000
    wasted = sum(g["total_size"] - g["size"] for g in groups)
    check("浪费空间 4000", wasted == 4000, f"got {wasted}")


def test_source_filter():
    print("  -- 源过滤 --")
    _clean()
    sid1 = _setup()
    sid2 = db.create_source({"name": "T2", "base_url": "http://y/dav",
                             "root_path": "/", "username": "u", "password": "p",
                             "enabled": 1})
    db.bulk_upsert_media(sid2, [
        _mk(sid2, "e.mp4", "/p", 500, "/p/e.mp4"),
        _mk(sid2, "e.mp4", "/q", 500, "/q/e.mp4"),
    ], partial=True)
    all_g = db.find_duplicates()
    check("全部含 e.mp4", any(g["name"] == "e.mp4" for g in all_g))
    g1 = db.find_duplicates([sid1])
    check("过滤后不含 e.mp4", not any(g["name"] == "e.mp4" for g in g1))
    check("过滤后仍有 2 组", len(g1) == 2, f"got {len(g1)}")


def test_no_dup():
    print("  -- 无重复 --")
    _clean()
    sid = db.create_source({"name": "T", "base_url": "http://z/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    db.bulk_upsert_media(sid, [
        _mk(sid, "u1.mp4", "/a", 100, "/a/u1.mp4"),
        _mk(sid, "u2.mp4", "/b", 200, "/b/u2.mp4"),
    ])
    check("无重复返回空", db.find_duplicates() == [])


if __name__ == "__main__":
    print("test_duplicates.py")
    test_basic()
    test_wasted()
    test_source_filter()
    test_no_dup()
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    sys.exit(1 if FAIL else 0)
