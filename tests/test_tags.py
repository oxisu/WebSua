#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标签 / 自定义分类：标签 CRUD + 按标签筛媒体。"""
import os
import sys
import tempfile

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-tag-test-")

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
    conn.execute("DELETE FROM media_tags")
    conn.execute("DELETE FROM tags")
    conn.execute("DELETE FROM media")
    conn.execute("DELETE FROM sources")
    conn.commit()


def _setup():
    sid = db.create_source({"name": "T", "base_url": "http://x/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    items = [
        {"name": f"v{i}.mp4", "remote_path": f"/m/v{i}.mp4", "folder": "/m",
         "size": 100 * i, "kind": "video", "mime": "video/mp4",
         "ext": ".mp4", "mtime": i}
        for i in range(1, 6)
    ]
    db.bulk_upsert_media(sid, items)
    # 按名排序取 id，保证 ids[0]=v1.mp4 … ids[4]=v5.mp4（默认 new 是时间倒序）
    rows, _ = db.query_media(order="name", limit=100)
    return sid, [r["id"] for r in rows]


def test_crud():
    print("  -- 标签 CRUD --")
    _clean()
    t1 = db.create_tag("剧集")
    check("创建标签返回 id", t1 is not None, f"got {t1}")
    t2 = db.create_tag("电影", "#e17055")
    check("第二个标签 id 不同", t1 != t2)

    check("重名返回 None", db.create_tag("剧集") is None)
    check("空名返回 None", db.create_tag("  ") is None)

    tags = db.list_tags()
    check("2 个标签", len(tags) == 2, f"got {len(tags)}")
    names = {t["name"] for t in tags}
    check("标签名正确", names == {"剧集", "电影"}, str(names))
    check("颜色保留", any(t["color"] == "#e17055" for t in tags))

    check("删除标签", db.delete_tag(t2))
    check("删后剩 1 个", len(db.list_tags()) == 1)
    check("删不存在返回 False", not db.delete_tag(9999))


def test_media_tags():
    print("  -- 媒体打标签 --")
    _clean()
    _, ids = _setup()
    t1 = db.create_tag("剧集")
    t2 = db.create_tag("收藏夹")

    db.set_media_tags(ids[0], [t1])
    db.set_media_tags(ids[1], [t1, t2])
    db.set_media_tags(ids[2], [t2])

    got = db.get_media_tags(ids)
    check("ids[0] 有 1 个标签", len(got.get(ids[0], [])) == 1)
    check("ids[1] 有 2 个标签", len(got.get(ids[1], [])) == 2)
    check("ids[3] 无标签", not got.get(ids[3]))
    check("标签名正确", got[ids[0]][0]["name"] == "剧集")

    # 全量覆盖：设为空 → 解绑
    db.set_media_tags(ids[1], [])
    got = db.get_media_tags([ids[1]])
    check("覆盖为空后解绑", not got.get(ids[1]))

    # 覆盖换成单个
    db.set_media_tags(ids[1], [t2])
    got = db.get_media_tags([ids[1]])
    check("覆盖后只有 t2", len(got[ids[1]]) == 1 and got[ids[1]][0]["name"] == "收藏夹")


def test_tag_filter():
    print("  -- 按标签筛媒体 --")
    _clean()
    _, ids = _setup()
    t1 = db.create_tag("剧集")
    t2 = db.create_tag("电影")
    db.set_media_tags(ids[0], [t1])
    db.set_media_tags(ids[1], [t1])
    db.set_media_tags(ids[2], [t2])

    _, total = db.query_media(limit=100)
    check("全部 5 条", total == 5, f"got {total}")

    rows, total = db.query_media(tag_ids=[t1], limit=100)
    check("剧集标签 2 条", total == 2, f"got {total}")

    rows, total = db.query_media(tag_ids=[t2], limit=100)
    check("电影标签 1 条", total == 1, f"got {total}")

    # 多标签 OR
    rows, total = db.query_media(tag_ids=[t1, t2], limit=100)
    check("两标签共 3 条", total == 3, f"got {total}")

    # 与搜索组合
    rows, total = db.query_media(tag_ids=[t1], search="v1", limit=100)
    check("标签+搜索 1 条", total == 1, f"got {total}")


def test_tag_count_and_cascade():
    print("  -- 计数与级联 --")
    _clean()
    _, ids = _setup()
    t1 = db.create_tag("剧集")
    db.set_media_tags(ids[0], [t1])
    db.set_media_tags(ids[1], [t1])
    tags = db.list_tags()
    check("媒体数 2", tags[0]["media_count"] == 2, f"got {tags[0]['media_count']}")

    # 删媒体 → media_tags 级联清掉
    db.delete_media([ids[0]])
    tags = db.list_tags()
    check("删媒体后计数 1", tags[0]["media_count"] == 1, f"got {tags[0]['media_count']}")

    # 删标签 → media_tags 级联清掉
    db.delete_tag(t1)
    got = db.get_media_tags(ids)
    check("删标签后全部解绑", all(not v for v in got.values()))


if __name__ == "__main__":
    print("test_tags.py")
    test_crud()
    test_media_tags()
    test_tag_filter()
    test_tag_count_and_cascade()
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    sys.exit(1 if FAIL else 0)
