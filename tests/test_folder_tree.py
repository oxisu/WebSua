#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文件夹树浏览：树形 API + folder_prefix 前缀匹配。"""
import os
import sys
import tempfile

os.environ["WEBSUA_DATA"] = tempfile.mkdtemp(prefix="websua-ft-test-")

sys.path.insert(0, os.path.dirname(__file__))
import _console  # noqa: F401  控制台编码兜底

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import backend.db as db

PASS = 0
FAIL = 0


def _clean():
    """清空媒体/源数据，让测试独立。"""
    conn = db.get_conn()
    conn.execute("DELETE FROM media")
    conn.execute("DELETE FROM sources")
    conn.execute("DELETE FROM favorites")
    conn.execute("DELETE FROM progress")
    conn.commit()


def check(name: str, ok: bool, detail: str = ""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [PASS] {name}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


def _setup_db():
    """插入测试数据到自动初始化的 DB。"""
    sid = db.create_source({"name": "测试源", "base_url": "http://x/dav",
                            "root_path": "/", "username": "u", "password": "p",
                            "enabled": 1})
    items = [
        {"name": "video1.mp4", "remote_path": "/movies/action/v1.mp4",
         "folder": "/movies/action", "size": 1000, "kind": "video",
         "mime": "video/mp4", "ext": ".mp4", "mtime": 1},
        {"name": "video2.mp4", "remote_path": "/movies/action/v2.mp4",
         "folder": "/movies/action", "size": 2000, "kind": "video",
         "mime": "video/mp4", "ext": ".mp4", "mtime": 2},
        {"name": "video3.mp4", "remote_path": "/movies/comedy/v3.mp4",
         "folder": "/movies/comedy", "size": 3000, "kind": "video",
         "mime": "video/mp4", "ext": ".mp4", "mtime": 3},
        {"name": "show1.mp4", "remote_path": "/tv/show1/e1.mp4",
         "folder": "/tv/show1", "size": 4000, "kind": "video",
         "mime": "video/mp4", "ext": ".mp4", "mtime": 4},
        {"name": "photo1.jpg", "remote_path": "/pics/p1.jpg",
         "folder": "/pics", "size": 500, "kind": "image",
         "mime": "image/jpeg", "ext": ".jpg", "mtime": 5},
    ]
    db.bulk_upsert_media(sid, items)
    return sid


def test_folder_tree_structure():
    print("  -- 树形结构 --")
    _clean()
    _setup_db()
    tree = db.folder_tree()
    check("返回 1 个源", len(tree) == 1, f"got {len(tree)}")
    src = tree[0]
    check("源名正确", src["source_name"] == "测试源")

    roots = src["tree"]
    root_names = {n["name"] for n in roots}
    check("根节点有 movies/tv/pics", root_names == {"movies", "tv", "pics"}, str(root_names))

    movies = next(n for n in roots if n["name"] == "movies")
    check("movies.count=3", movies["count"] == 3, f"got {movies['count']}")
    check("movies.total_size=6000", movies["total_size"] == 6000, f"got {movies['total_size']}")
    check("movies 有 2 个子节点", len(movies["children"]) == 2)

    action = next(n for n in movies["children"] if n["name"] == "action")
    check("action.count=2", action["count"] == 2, f"got {action['count']}")
    check("action.path=/movies/action", action["path"] == "/movies/action")


def test_folder_prefix_filter():
    print("  -- folder_prefix 前缀匹配 --")
    _clean()
    _setup_db()
    # /movies 应匹配 action + comedy 共 3 条
    rows, total = db.query_media(folder_prefix="/movies", limit=100)
    check("/movies 匹配 3 条", total == 3, f"got {total}")
    names = {r["name"] for r in rows}
    check("/movies 包含 v1/v2/v3", names == {"video1.mp4", "video2.mp4", "video3.mp4"}, str(names))

    # /movies/action 只匹配 2 条
    rows, total = db.query_media(folder_prefix="/movies/action", limit=100)
    check("/movies/action 匹配 2 条", total == 2, f"got {total}")

    # 精确 folder 仍工作
    rows, total = db.query_media(folder="/movies/action", limit=100)
    check("folder 精确匹配 2 条", total == 2, f"got {total}")

    # /tv 匹配 show1 子目录
    rows, total = db.query_media(folder_prefix="/tv", limit=100)
    check("/tv 匹配 1 条（子目录）", total == 1, f"got {total}")


def test_folder_tree_with_source_filter():
    print("  -- 源过滤 --")
    _clean()
    sid1 = _setup_db()
    sid2 = db.create_source({"name": "第二源", "base_url": "http://y/dav",
                             "root_path": "/", "username": "u", "password": "p",
                             "enabled": 1})
    db.bulk_upsert_media(sid2, [{
        "name": "other.mp4", "remote_path": "/a/o.mp4", "folder": "/a",
        "size": 100, "kind": "video", "mime": "video/mp4", "ext": ".mp4",
        "mtime": 1}])

    tree = db.folder_tree()
    check("默认返回 2 个源", len(tree) == 2, f"got {len(tree)}")

    tree = db.folder_tree([sid1])
    check("过滤后返回 1 个源", len(tree) == 1, f"got {len(tree)}")
    check("过滤后是测试源", tree[0]["source_name"] == "测试源")


def test_folder_tree_empty():
    print("  -- 空数据 --")
    _clean()
    tree = db.folder_tree()
    check("无源时返回空", tree == [], f"got {tree}")


def test_folder_tree_aggregation():
    print("  -- 多层聚合 --")
    _clean()
    sid = _setup_db()
    db.bulk_upsert_media(sid, [{
        "name": "deep.mp4", "remote_path": "/movies/action/deep/d.mp4",
        "folder": "/movies/action/deep", "size": 999, "kind": "video",
        "mime": "video/mp4", "ext": ".mp4", "mtime": 9}], partial=True)
    tree = db.folder_tree()
    src = tree[0]
    movies = next(n for n in src["tree"] if n["name"] == "movies")
    check("movies 聚合 count=4", movies["count"] == 4, f"got {movies['count']}")
    action = next(n for n in movies["children"] if n["name"] == "action")
    check("action 聚合 count=3", action["count"] == 3, f"got {action['count']}")
    check("action 有 deep 子节点", len(action["children"]) == 1)
    deep = action["children"][0]
    check("deep.count=1", deep["count"] == 1)
    check("deep.path 正确", deep["path"] == "/movies/action/deep")


if __name__ == "__main__":
    print("test_folder_tree.py")
    test_folder_tree_structure()
    test_folder_prefix_filter()
    test_folder_tree_with_source_filter()
    test_folder_tree_empty()
    test_folder_tree_aggregation()
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    sys.exit(1 if FAIL else 0)
