#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按源聚合统计：媒体数分类型 / 大小 / 目录数 / 失败目录数 / 最近扫描。"""
import os
import sys
import tempfile
import time

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-stats-test-")

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
    conn.execute("DELETE FROM scan_failed")
    conn.execute("DELETE FROM media")
    conn.execute("DELETE FROM sources")
    conn.commit()


def _setup():
    sid = db.create_source({"name": "源A", "base_url": "http://a/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    items = [
        {"name": "v1.mp4", "remote_path": "/m/v1.mp4", "folder": "/m",
         "size": 1000, "kind": "video", "mime": "video/mp4", "ext": ".mp4", "mtime": 1},
        {"name": "v2.mp4", "remote_path": "/m/v2.mp4", "folder": "/m",
         "size": 2000, "kind": "video", "mime": "video/mp4", "ext": ".mp4", "mtime": 2},
        {"name": "p1.jpg", "remote_path": "/pics/p1.jpg", "folder": "/pics",
         "size": 500, "kind": "image", "mime": "image/jpeg", "ext": ".jpg", "mtime": 3},
        {"name": "a1.mp3", "remote_path": "/m/a1.mp3", "folder": "/m",
         "size": 300, "kind": "audio", "mime": "audio/mpeg", "ext": ".mp3", "mtime": 4},
    ]
    db.bulk_upsert_media(sid, items)
    # 记录失败目录与最近扫描
    db.save_failed_dirs(sid, [("/big", "timeout"), ("/x", "403")])
    db.update_source(sid, {"last_scan_at": int(time.time()), "last_scan_ms": 12345})
    return sid


def test_source_stats():
    print("  -- 按源统计 --")
    _clean()
    sid = _setup()
    rows = db.source_stats()
    check("1 个源", len(rows) == 1, f"got {len(rows)}")
    s = rows[0]
    check("source_id 正确", s["source_id"] == sid)
    check("媒体数 4", s["media_count"] == 4, f"got {s['media_count']}")
    check("视频 2", s["videos"] == 2, f"got {s['videos']}")
    check("图片 1", s["images"] == 1, f"got {s['images']}")
    check("音频 1", s["audio"] == 1, f"got {s['audio']}")
    check("总大小 3800", s["total_size"] == 3800, f"got {s['total_size']}")
    check("目录数 2", s["folder_count"] == 2, f"got {s['folder_count']}")
    check("失败目录 2", s["failed_dirs"] == 2, f"got {s['failed_dirs']}")
    check("最近扫描时间有值", s["last_scan_at"], f"got {s['last_scan_at']}")
    check("最近扫描耗时 12345", s["last_scan_ms"] == 12345)


def test_empty_source():
    print("  -- 空源 --")
    _clean()
    db.create_source({"name": "空源", "base_url": "http://z/dav",
                      "root_path": "/", "username": "u", "password": "p",
                      "enabled": 1})
    rows = db.source_stats()
    s = rows[0]
    check("媒体数 0", s["media_count"] == 0, f"got {s['media_count']}")
    check("总大小 0", s["total_size"] == 0)
    check("目录数 0", s["folder_count"] == 0)
    check("失败目录 0", s["failed_dirs"] == 0)


def test_multi_source():
    print("  -- 多源 --")
    _clean()
    sid1 = _setup()
    sid2 = db.create_source({"name": "源B", "base_url": "http://b/dav",
                             "root_path": "/", "username": "u", "password": "p",
                             "enabled": 1})
    db.bulk_upsert_media(sid2, [{
        "name": "w1.mp4", "remote_path": "/w/w1.mp4", "folder": "/w",
        "size": 700, "kind": "video", "mime": "video/mp4", "ext": ".mp4", "mtime": 1,
    }], partial=True)
    rows = db.source_stats()
    check("2 个源", len(rows) == 2, f"got {len(rows)}")
    by_id = {r["source_id"]: r for r in rows}
    check("源A 媒体 4", by_id[sid1]["media_count"] == 4)
    check("源B 媒体 1", by_id[sid2]["media_count"] == 1)
    check("源B 失败目录 0", by_id[sid2]["failed_dirs"] == 0)
    check("源B 目录 1", by_id[sid2]["folder_count"] == 1)


if __name__ == "__main__":
    print("test_stats_agg.py")
    test_source_stats()
    test_empty_source()
    test_multi_source()
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    sys.exit(1 if FAIL else 0)
