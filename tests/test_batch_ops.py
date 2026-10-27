#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量操作：批量收藏 / 批量移除索引。"""
import os
import sys
import tempfile

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-batch-test-")

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


def _setup():
    sid = db.create_source({"name": "T", "base_url": "http://x/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    items = [
        {"name": f"v{i}.mp4", "remote_path": f"/m/v{i}.mp4", "folder": "/m",
         "size": 100 * i, "kind": "video", "mime": "video/mp4",
         "ext": ".mp4", "mtime": i}
        for i in range(1, 7)
    ]
    db.bulk_upsert_media(sid, items)
    # 返回实际 media id 列表
    rows, _ = db.query_media(limit=100)
    return sid, [r["id"] for r in rows]


def test_batch_fav():
    print("  -- 批量收藏 --")
    _clean()
    _, ids_all = _setup()
    ids = [ids_all[0], ids_all[2], ids_all[4]]
    n = db.batch_set_favorite(ids, True)
    check("批量收藏 3 条", n == 3, f"got {n}")
    check("第1条已收藏", db.is_favorite(ids_all[0]))
    check("第3条已收藏", db.is_favorite(ids_all[2]))
    check("第2条未收藏", not db.is_favorite(ids_all[1]))

    # 幂等：再收藏一次不重复计数
    n = db.batch_set_favorite(ids, True)
    check("重复收藏 0 变更", n == 0, f"got {n}")

    # 批量取消
    n = db.batch_set_favorite([ids_all[0], ids_all[2]], False)
    check("取消收藏 2 条", n == 2, f"got {n}")
    check("第1条已取消", not db.is_favorite(ids_all[0]))
    check("第5条仍收藏", db.is_favorite(ids_all[4]))


def test_batch_remove():
    print("  -- 批量移除索引 --")
    _clean()
    _, ids_all = _setup()
    db.batch_set_favorite([ids_all[0], ids_all[1]], True)
    db.save_progress(ids_all[0], 50, 100)

    _, total_before = db.query_media(limit=100)
    check("移除前 6 条", total_before == 6, f"got {total_before}")

    n = db.delete_media(ids_all[:3])
    check("移除 3 条", n == 3, f"got {n}")

    _, total_after = db.query_media(limit=100)
    check("移除后 3 条", total_after == 3, f"got {total_after}")
    check("第1条已移除", db.get_media(ids_all[0]) is None)
    check("第4条仍存在", db.get_media(ids_all[3]) is not None)

    # 关联数据也被清
    check("第1条收藏已清", not db.is_favorite(ids_all[0]))
    check("第1条进度已清", db.get_progress(ids_all[0]) is None)

    # 移除不存在的 id 不崩
    n = db.delete_media([999, 1000])
    check("移除不存在 0 条", n == 0, f"got {n}")


def test_batch_empty():
    print("  -- 空列表 --")
    _clean()
    check("空收藏 0", db.batch_set_favorite([], True) == 0)
    check("空移除 0", db.delete_media([]) == 0)


if __name__ == "__main__":
    print("test_batch_ops.py")
    test_batch_fav()
    test_batch_remove()
    test_batch_empty()
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    sys.exit(1 if FAIL else 0)
