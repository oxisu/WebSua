"""SQLite 数据层：数据源、媒体文件、观看进度、收藏。

纯标准库实现 —— 单连接 + 可重入锁，保证多线程 HTTP 服务器下的安全。
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from typing import Any, Iterable

from .config import DB_PATH

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    base_url      TEXT NOT NULL,
    username      TEXT,
    password      TEXT,
    root_path     TEXT DEFAULT '/',
    kind          TEXT DEFAULT 'video',
    icon          TEXT DEFAULT '',
    color         TEXT DEFAULT '',
    sort          INTEGER DEFAULT 0,
    enabled       INTEGER DEFAULT 1,
    auto_scan     INTEGER DEFAULT 0,
    verify_ssl    INTEGER DEFAULT 1,
    tg_mode       INTEGER DEFAULT 0,
    exclude_dirs  TEXT DEFAULT '',
    last_scan_at  INTEGER,
    last_scan_ms  INTEGER,
    last_error    TEXT,
    item_count    INTEGER DEFAULT 0,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    remote_path   TEXT NOT NULL,
    name          TEXT NOT NULL,
    ext           TEXT,
    kind          TEXT NOT NULL DEFAULT 'video',
    mime          TEXT,
    size          INTEGER DEFAULT 0,
    mtime         INTEGER,
    duration      REAL,
    width         INTEGER,
    height        INTEGER,
    folder        TEXT DEFAULT '',
    poster_path   TEXT DEFAULT '',
    subtitle_path TEXT DEFAULT '',
    content_hash  TEXT,
    indexed_at    INTEGER NOT NULL,
    UNIQUE(source_id, remote_path)
);

CREATE INDEX IF NOT EXISTS idx_media_source ON media(source_id);
CREATE INDEX IF NOT EXISTS idx_media_kind   ON media(source_id, kind);
CREATE INDEX IF NOT EXISTS idx_media_size   ON media(source_id, size DESC);
CREATE INDEX IF NOT EXISTS idx_media_folder ON media(source_id, folder);

CREATE TABLE IF NOT EXISTS progress (
    media_id      INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    position      REAL DEFAULT 0,
    duration      REAL DEFAULT 0,
    watched_at    INTEGER NOT NULL,
    finished      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorites (
    media_id      INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key           TEXT PRIMARY KEY,
    value         TEXT
);

-- 增量扫描 / 断点续扫：扫描中途发现的文件先落暂存表。
-- 取消或进程中断时进度不丢，「继续扫描」从 scan_state 的目录栈接着走。
CREATE TABLE IF NOT EXISTS scan_stage (
    source_id     INTEGER NOT NULL,
    remote_path   TEXT NOT NULL,
    name          TEXT NOT NULL,
    ext           TEXT,
    kind          TEXT NOT NULL DEFAULT 'video',
    mime          TEXT,
    size          INTEGER DEFAULT 0,
    mtime         INTEGER,
    folder        TEXT DEFAULT '',
    poster_path   TEXT DEFAULT '',
    subtitle_path TEXT DEFAULT '',
    PRIMARY KEY (source_id, remote_path)
);

-- 断点续扫的遍历现场：待遍历目录栈 + 已访问目录 + 扫描参数快照。
-- root/exclude/max_depth 与当前数据源不一致时视为过期，忽略重扫。
-- mode 记录这一轮是全量还是增量 —— 续扫的收尾提交要按原模式来。
CREATE TABLE IF NOT EXISTS scan_state (
    source_id     INTEGER PRIMARY KEY,
    root          TEXT NOT NULL,
    max_depth     INTEGER NOT NULL DEFAULT 8,
    exclude       TEXT DEFAULT '',
    mode          TEXT DEFAULT 'full',
    stack         TEXT DEFAULT '[]',
    visited       TEXT DEFAULT '[]',
    started_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- 失败目录：每次扫描完成（done）时原子刷新。宁可暴露也绝不静默丢弃。
-- folder 是规范化后的目录路径（含开头斜杠，无结尾斜杠）。
-- 扫描中途某目录列举失败，整个子树的文件都会消失 —— 这些目录必须可被
-- 观测、可被「只重扫失败目录」复用，而不是只躺在日志文本里。
CREATE TABLE IF NOT EXISTS scan_failed (
    source_id   INTEGER NOT NULL,
    folder      TEXT NOT NULL,
    error       TEXT,
    scan_mode   TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (source_id, folder)
);

-- 扫描差异报告：每次「完成的扫描」写一行，记录相对库现状的增/改/删/未变，
-- 以及被远端删除的具体路径（missing），让「消失的媒体」可观测、可追溯。
CREATE TABLE IF NOT EXISTS scan_diff (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL,
    mode        TEXT,
    added       INTEGER DEFAULT 0,
    updated     INTEGER DEFAULT 0,
    removed     INTEGER DEFAULT 0,
    unchanged   INTEGER DEFAULT 0,
    missing     TEXT DEFAULT '',
    created_at  INTEGER NOT NULL
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """增量迁移：老库补新列。幂等，用 PRAGMA table_info 判断。"""
    def cols(table: str) -> set[str]:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}

    if "poster_path" not in cols("media"):
        conn.execute("ALTER TABLE media ADD COLUMN poster_path TEXT DEFAULT ''")
    if "subtitle_path" not in cols("media"):
        conn.execute("ALTER TABLE media ADD COLUMN subtitle_path TEXT DEFAULT ''")
    if "tg_mode" not in cols("sources"):
        conn.execute("ALTER TABLE sources ADD COLUMN tg_mode INTEGER DEFAULT 0")
    if "exclude_dirs" not in cols("sources"):
        conn.execute("ALTER TABLE sources ADD COLUMN exclude_dirs TEXT DEFAULT ''")


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _conn.executescript(SCHEMA)
        _migrate(_conn)
        _conn.commit()
    return _conn


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


# ---------------- sources ----------------

def list_sources(only_enabled: bool = False) -> list[dict[str, Any]]:
    sql = "SELECT * FROM sources"
    if only_enabled:
        sql += " WHERE enabled = 1"
    sql += " ORDER BY sort ASC, id ASC"
    with _lock:
        return rows_to_dicts(get_conn().execute(sql).fetchall())


def get_source(source_id: int) -> dict[str, Any] | None:
    with _lock:
        row = get_conn().execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    return dict(row) if row else None


def create_source(data: dict[str, Any]) -> int:
    now = int(time.time())
    with _lock:
        cur = get_conn().execute(
            """INSERT INTO sources
               (name, base_url, username, password, root_path, kind, icon, color,
                sort, enabled, auto_scan, verify_ssl, tg_mode, exclude_dirs, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
             (data["name"], data["base_url"].rstrip("/"),
              data.get("username") or "", data.get("password") or "",
              data.get("root_path") or "/", data.get("kind") or "video",
              data.get("icon") or "", data.get("color") or "",
              int(data.get("sort", 0)), 1 if data.get("enabled", True) else 0,
              1 if data.get("auto_scan") else 0,
              1 if data.get("verify_ssl", True) else 0,
              1 if data.get("tg_mode") else 0,
              data.get("exclude_dirs") or "", now),
        )
        get_conn().commit()
    return int(cur.lastrowid)


_INT_FIELDS = {"sort", "enabled", "auto_scan", "verify_ssl", "tg_mode",
               "last_scan_at", "last_scan_ms", "item_count"}


def update_source(source_id: int, data: dict[str, Any]) -> bool:
    allowed = {
        "name", "base_url", "username", "password", "root_path", "kind",
        "icon", "color", "sort", "enabled", "auto_scan", "verify_ssl", "tg_mode",
        "exclude_dirs",
        "last_scan_at", "last_scan_ms", "last_error", "item_count",
    }
    sets, vals = [], []
    for k, v in data.items():
        if k in allowed:
            sets.append(f"{k} = ?")
            vals.append(int(v) if k in _INT_FIELDS else v)
    if not sets:
        return False
    vals.append(source_id)
    with _lock:
        cur = get_conn().execute(f"UPDATE sources SET {', '.join(sets)} WHERE id = ?", vals)
        get_conn().commit()
    return cur.rowcount > 0


def delete_source(source_id: int) -> bool:
    with _lock:
        conn = get_conn()
        conn.execute("DELETE FROM media WHERE source_id = ?", (source_id,))
        # 扫描暂存表 / 断点 / 失败目录 / 差异报告没有外键级联，手动清掉，
        # 否则删源后留下一具「可继续扫描」的僵尸进度，指向已经不存在的源
        conn.execute("DELETE FROM scan_stage WHERE source_id = ?", (source_id,))
        conn.execute("DELETE FROM scan_state WHERE source_id = ?", (source_id,))
        conn.execute("DELETE FROM scan_failed WHERE source_id = ?", (source_id,))
        conn.execute("DELETE FROM scan_diff WHERE source_id = ?", (source_id,))
        cur = conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
        conn.commit()
    return cur.rowcount > 0


# ---------------- 失败目录 / 扫描差异报告 ----------------

def clear_failed_dirs(source_id: int) -> None:
    with _lock:
        get_conn().execute("DELETE FROM scan_failed WHERE source_id = ?", (source_id,))
        get_conn().commit()


def save_failed_dirs(source_id: int, entries: list[tuple[str, str]],
                      mode: str = "") -> None:
    """原子刷新某源的失败目录：先清空再写入本轮结果。

    entries: [(folder, error), ...]（folder 为规范化路径）。
    空列表表示本轮没有失败目录 —— 表随之清空，「重扫失败目录」按钮与
    失败徽标自然消失。
    """
    now = int(time.time())
    with _lock:
        conn = get_conn()
        conn.execute("DELETE FROM scan_failed WHERE source_id = ?", (source_id,))
        if entries:
            conn.executemany(
                "INSERT INTO scan_failed "
                "(source_id, folder, error, scan_mode, created_at) VALUES (?,?,?,?,?)",
                [(source_id, f, e, mode, now) for f, e in entries],
            )
        conn.commit()


def get_failed_dirs(source_id: int) -> list[dict[str, Any]]:
    with _lock:
        rows = get_conn().execute(
            "SELECT folder, error, scan_mode, created_at FROM scan_failed "
            "WHERE source_id = ? ORDER BY folder", (source_id,)).fetchall()
    return rows_to_dicts(rows)


def save_scan_diff(source_id: int, mode: str, added: int, updated: int,
                   removed: int, unchanged: int,
                   missing: list[str] | None = None) -> None:
    """记录一次完成的扫描与库现状的差异（新增/更新/消失/未变/消失路径）。"""
    now = int(time.time())
    with _lock:
        get_conn().execute(
            "INSERT INTO scan_diff "
            "(source_id, mode, added, updated, removed, unchanged, missing, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (source_id, mode, added, updated, removed, unchanged,
             json.dumps(missing or [], ensure_ascii=False), now))
        get_conn().commit()


def get_last_diff(source_id: int) -> dict[str, Any] | None:
    with _lock:
        row = get_conn().execute(
            "SELECT * FROM scan_diff WHERE source_id = ? ORDER BY id DESC LIMIT 1",
            (source_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["missing"] = json.loads(d["missing"] or "[]")
    except (json.JSONDecodeError, TypeError, ValueError):
        d["missing"] = []
    return d


def count_media_by_source(source_id: int) -> int:
    with _lock:
        return get_conn().execute(
            "SELECT COUNT(*) c FROM media WHERE source_id = ?", (source_id,)
        ).fetchone()["c"]


# ---------------- media ----------------

def _same_signature(old: sqlite3.Row, it: dict[str, Any]) -> bool:
    """远端条目与库里记录是否「同一份内容」。

    增量扫描的判定依据：大小、修改时间、关联封面/字幕全都一致才认为没变。
    网盘的 getlastmodified 精度到秒，同秒内改动会被漏过 —— 可接受：
    漏过的后果只是多写一次行，不会丢数据。
    """
    return (int(old["size"] or 0) == int(it.get("size") or 0)
            and old["mtime"] == it.get("mtime")
            and (old["poster_path"] or "") == (it.get("poster_path") or "")
            and (old["subtitle_path"] or "") == (it.get("subtitle_path") or ""))


def bulk_upsert_media(source_id: int, items: list[dict[str, Any]],
                      incremental: bool = False,
                      partial: bool = False) -> tuple[int, int, int, int, list[str]]:
    """写入/更新媒体条目。

    返回 (新增数, 更新数, 清理数, 未变数, 被移除的路径列表)。

    注意：远端 PROPFIND 可能返回重复条目（123 云盘等网盘出现过），
    items 内同 remote_path 出现两次时，若不做防重，第二次 INSERT 会
    撞 UNIQUE(source_id, remote_path) 让整个扫描中途失败。

    incremental=True（增量扫描）：(size, mtime, poster, subtitle) 与库里
    完全一致的条目直接跳过 —— 不写库、不刷新 indexed_at。否则每次重扫
    都会把全表 indexed_at 刷成「刚刚」，视频流的「最新」排序失去意义，
    纯属写放大。

    partial=True（只重扫失败目录）：只新增/更新本轮 items，绝不删除库中
    其余条目 —— 否则「只扫失败目录」会把正常目录里已有的媒体全部判为
    「消失」而删掉。被移除路径恒为空列表。
    """
    now = int(time.time())
    with _lock:
        conn = get_conn()
        existing = {
            r["remote_path"]: r
            for r in conn.execute(
                """SELECT id, remote_path, size, mtime, poster_path, subtitle_path
                   FROM media WHERE source_id = ?""", (source_id,))
        }
        seen: set[str] = set()
        added = updated = unchanged = 0
        for it in items:
            rp = it["remote_path"]
            if rp in seen:
                continue   # 本轮已处理过（远端重复条目），跳过防 UNIQUE 崩溃
            seen.add(rp)
            old = existing.get(rp)
            if old is not None:
                if incremental and _same_signature(old, it):
                    unchanged += 1
                    continue
                conn.execute(
                    """UPDATE media SET name=?, ext=?, kind=?, mime=?, size=?, mtime=?,
                       folder=?, poster_path=?, subtitle_path=?, indexed_at=? WHERE id=?""",
                    (it["name"], it.get("ext"), it.get("kind", "video"), it.get("mime"),
                     int(it.get("size") or 0), it.get("mtime"),
                     it.get("folder", ""), it.get("poster_path", ""),
                     it.get("subtitle_path", ""), now, old["id"]),
                )
                updated += 1
            else:
                conn.execute(
                    """INSERT INTO media
                       (source_id, remote_path, name, ext, kind, mime, size, mtime,
                        folder, poster_path, subtitle_path, duration, width, height, indexed_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (source_id, rp, it["name"], it.get("ext"), it.get("kind", "video"),
                     it.get("mime"), int(it.get("size") or 0), it.get("mtime"),
                     it.get("folder", ""), it.get("poster_path", ""),
                     it.get("subtitle_path", ""),
                     it.get("duration"), it.get("width"),
                     it.get("height"), now),
                )
                added += 1
        gone = [row for rp, row in existing.items() if rp not in seen]
        removed_paths = [row["remote_path"] for row in gone]
        removed = 0
        if not partial:
            removed = len(gone)
            for i in range(0, len(gone), 400):
                chunk = gone[i:i + 400]
                conn.execute(
                    f"DELETE FROM media WHERE id IN ({','.join('?' * len(chunk))})",
                    [row["id"] for row in chunk])
        conn.commit()
    return added, updated, removed, unchanged, removed_paths


# ---------------- 增量扫描 / 断点续扫 ----------------

def stage_clear(source_id: int) -> None:
    """清空某个源的扫描暂存表（新一轮全量扫描开始时）。"""
    with _lock:
        get_conn().execute("DELETE FROM scan_stage WHERE source_id = ?", (source_id,))
        get_conn().commit()


def stage_put_many(source_id: int, rows: list[dict[str, Any]]) -> None:
    """批量写入暂存表。PK(source_id, remote_path) 天然防重 ——
    续扫时上一轮已发现的条目重复写入只是覆盖，不会炸 UNIQUE。"""
    if not rows:
        return
    with _lock:
        conn = get_conn()
        conn.executemany(
            """INSERT INTO scan_stage
               (source_id, remote_path, name, ext, kind, mime, size, mtime,
                folder, poster_path, subtitle_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source_id, remote_path) DO UPDATE SET
                 name=excluded.name, ext=excluded.ext, kind=excluded.kind,
                 mime=excluded.mime, size=excluded.size, mtime=excluded.mtime,
                 folder=excluded.folder, poster_path=excluded.poster_path,
                 subtitle_path=excluded.subtitle_path""",
            [(source_id, r["remote_path"], r["name"], r.get("ext"),
              r.get("kind", "video"), r.get("mime"), int(r.get("size") or 0),
              r.get("mtime"), r.get("folder", ""), r.get("poster_path", ""),
              r.get("subtitle_path", "")) for r in rows],
        )
        conn.commit()


def stage_count(source_id: int) -> int:
    with _lock:
        return get_conn().execute(
            "SELECT COUNT(*) c FROM scan_stage WHERE source_id = ?", (source_id,)
        ).fetchone()["c"]


def iter_stage_rows(source_id: int, chunk: int = 2000):
    """分批读出暂存条目（生成器）—— 收尾阶段全量进内存前先留一条流式出口。"""
    last = ""
    while True:
        with _lock:
            rows = get_conn().execute(
                """SELECT * FROM scan_stage WHERE source_id = ? AND remote_path > ?
                   ORDER BY remote_path LIMIT ?""", (source_id, last, chunk)
            ).fetchall()
        if not rows:
            return
        for r in rows:
            yield dict(r)
        last = rows[-1]["remote_path"]


def get_scan_state(source_id: int) -> dict[str, Any] | None:
    with _lock:
        row = get_conn().execute(
            "SELECT * FROM scan_state WHERE source_id = ?", (source_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["stack"] = [tuple(x) for x in json.loads(d["stack"])]
    except (json.JSONDecodeError, TypeError, ValueError):
        d["stack"] = []
    try:
        d["visited"] = list(json.loads(d["visited"]))
    except (json.JSONDecodeError, TypeError, ValueError):
        d["visited"] = []
    return d


def save_scan_state(source_id: int, root: str, max_depth: int, exclude: str,
                    stack: list, visited: list, mode: str = "full") -> None:
    """持久化遍历现场。stack/visited 是全量快照（不是增量）——
    调用方负责节流（见 config.SCAN_STATE_SAVE_EVERY_*）。"""
    now = int(time.time())
    with _lock:
        get_conn().execute(
            """INSERT INTO scan_state
               (source_id, root, max_depth, exclude, mode, stack, visited, started_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(source_id) DO UPDATE SET
                 root=excluded.root, max_depth=excluded.max_depth,
                 exclude=excluded.exclude, mode=excluded.mode,
                 stack=excluded.stack, visited=excluded.visited,
                 updated_at=excluded.updated_at""",
            (source_id, root, int(max_depth), exclude or "",
             mode if mode in ("full", "incremental", "failed") else "full",
             json.dumps([list(x) for x in stack], ensure_ascii=False),
             json.dumps(list(visited), ensure_ascii=False),
             now, now),
        )
        get_conn().commit()


def clear_scan_state(source_id: int) -> None:
    """扫描完成 / 用户放弃：清掉断点与暂存表。"""
    with _lock:
        conn = get_conn()
        conn.execute("DELETE FROM scan_state WHERE source_id = ?", (source_id,))
        conn.execute("DELETE FROM scan_stage WHERE source_id = ?", (source_id,))
        conn.commit()


def has_resumable_scan(source_id: int) -> bool:
    with _lock:
        row = get_conn().execute(
            "SELECT 1 FROM scan_state WHERE source_id = ?", (source_id,)).fetchone()
    return row is not None


def get_media(media_id: int) -> dict[str, Any] | None:
    with _lock:
        row = get_conn().execute(
            """SELECT m.*, s.name AS source_name, s.base_url, s.username, s.password,
                      s.root_path AS source_root, s.id AS sid, s.color AS source_color,
                      s.verify_ssl
               FROM media m JOIN sources s ON s.id = m.source_id
               WHERE m.id = ?""", (media_id,)
        ).fetchone()
    return dict(row) if row else None


_NAT_RE = re.compile(r"(\d+)")


def natural_key(name: str) -> list:
    """自然排序键：把文件名里的数字段按**数值**比较。

    「第2集」必须排在「第10集」前面 —— 纯字典序会把 10 排到 2 前面，
    「下一集」连播就整个乱了。SQLite 没有自然排序，只能取出后在本进程排。
    """
    return [int(t) if t.isdigit() else (t or "").lower()
            for t in _NAT_RE.split(name or "")]


def get_media_many(ids: list[int]) -> list[dict[str, Any]]:
    """按给定顺序取媒体（含来源/收藏信息），不存在的 id 跳过。

    播放队列只存 id，渲染前用这个接口解析成当前实际存在的条目 ——
    文件被删、源被停用时自然剔除，不会留下点得动却打不开的队列项。
    """
    clean = []
    for x in ids:
        try:
            v = int(x)
        except (TypeError, ValueError):
            continue
        if v > 0:
            clean.append(v)
    if not clean:
        return []
    found: dict[int, dict[str, Any]] = {}
    with _lock:
        conn = get_conn()
        for i in range(0, len(clean), 500):
            chunk = clean[i:i + 500]
            ph = ",".join("?" * len(chunk))
            for r in conn.execute(
                f"""SELECT m.*, s.name AS source_name, s.color AS source_color,
                           s.enabled AS source_enabled,
                           (f.media_id IS NOT NULL) AS is_fav
                    FROM media m
                    JOIN sources s ON s.id = m.source_id
                    LEFT JOIN favorites f ON f.media_id = m.id
                    WHERE m.id IN ({ph})""", chunk):
                found[r["id"]] = dict(r)
    return [found[i] for i in clean if i in found]


def query_media(
    source_ids: list[int] | None = None,
    kinds: list[str] | None = None,
    folder: str | None = None,
    folder_prefix: str | None = None,
    search: str | None = None,
    order: str = "new",
    limit: int = 60,
    offset: int = 0,
    favorite_only: bool = False,
) -> tuple[list[dict[str, Any]], int]:
    where, params = ["s.enabled = 1"], []
    if source_ids:
        where.append(f"m.source_id IN ({','.join('?' * len(source_ids))})")
        params += list(source_ids)
    if kinds:
        where.append(f"m.kind IN ({','.join('?' * len(kinds))})")
        params += list(kinds)
    if folder:
        where.append("m.folder = ?")
        params.append(folder)
    if folder_prefix:
        # 前缀匹配：/movies 能匹配 /movies 和 /movies/action 等子目录
        where.append("(m.folder = ? OR m.folder LIKE ?)")
        params.append(folder_prefix)
        params.append(folder_prefix.rstrip("/") + "/%")
    if search:
        where.append("m.name LIKE ?")
        params.append(f"%{search}%")
    if favorite_only:
        where.append("m.id IN (SELECT media_id FROM favorites)")
    clause = " WHERE " + " AND ".join(where)
    orders = {
        "new": "m.indexed_at DESC, m.id DESC",
        "old": "m.indexed_at ASC, m.id ASC",
        "name": "m.name ASC",
        "big": "m.size DESC",
        "small": "m.size ASC",
        "random": "RANDOM()",
    }
    with _lock:
        conn = get_conn()
        if order == "natural":
            # 自然序只能全量取出后在本进程排（见 natural_key）。
            # 只用于「按目录生成播放队列」这类小结果集，封顶 2 万条防内存爆炸。
            rows = conn.execute(
                f"""SELECT m.*, s.name AS source_name, s.color AS source_color,
                           p.position AS position, p.finished AS finished,
                           (f.media_id IS NOT NULL) AS is_fav
                    FROM media m
                    JOIN sources s ON s.id = m.source_id
                    LEFT JOIN progress p ON p.media_id = m.id
                    LEFT JOIN favorites f ON f.media_id = m.id
                    {clause}
                    ORDER BY m.folder, m.name
                    LIMIT 20000""",
                params).fetchall()
            rows = sorted(rows_to_dicts(rows),
                          key=lambda r: (r.get("folder") or "",
                                         natural_key(r.get("name") or "")))
            return rows[offset:offset + limit], len(rows)
        total = conn.execute(
            f"SELECT COUNT(*) c FROM media m JOIN sources s ON s.id = m.source_id{clause}",
            params).fetchone()["c"]
        rows = conn.execute(
            f"""SELECT m.*, s.name AS source_name, s.color AS source_color,
                       p.position AS position, p.finished AS finished,
                       (f.media_id IS NOT NULL) AS is_fav
                FROM media m
                JOIN sources s ON s.id = m.source_id
                LEFT JOIN progress p ON p.media_id = m.id
                LEFT JOIN favorites f ON f.media_id = m.id
                {clause}
                ORDER BY {orders.get(order, orders['new'])}
                LIMIT ? OFFSET ?""",
            params + [limit, offset],
        ).fetchall()
    return rows_to_dicts(rows), total


def list_folders(source_id: int) -> list[dict[str, Any]]:
    with _lock:
        rows = get_conn().execute(
            """SELECT folder, COUNT(*) c, COALESCE(SUM(size),0) total
               FROM media WHERE source_id = ? AND folder != ''
               GROUP BY folder ORDER BY folder""", (source_id,)
        ).fetchall()
    return rows_to_dicts(rows)


def folder_tree(source_ids: list[int] | None = None) -> list[dict[str, Any]]:
    """按 source 返回目录树（每层带媒体计数与大小）。

    返回格式：[{"source_id":…, "source_name":…, "tree": [节点…]}]
    节点：{path, name, count, total_size, children:[…]}
    """
    sources = list_sources()
    out = []
    for s in sources:
        if source_ids and s["id"] not in source_ids:
            continue
        if not s.get("enabled"):
            continue
        with _lock:
            rows = get_conn().execute(
                """SELECT folder, COUNT(*) c, COALESCE(SUM(size),0) total
                   FROM media WHERE source_id = ? AND folder != ''
                   GROUP BY folder ORDER BY folder""", (s["id"],)
            ).fetchall()
        entries = rows_to_dicts(rows)
        tree = _build_tree(entries)
        out.append({"source_id": s["id"], "source_name": s["name"],
                    "source_color": s.get("color"), "tree": tree})
    return out


def _build_tree(entries: list[dict]) -> list[dict]:
    """把扁平 folder 列表构建成嵌套树。folder 形如 /a/b/c。"""
    nodes: dict[str, dict] = {}
    roots: list[dict] = []
    for e in entries:
        path = e["folder"]
        parts = [p for p in path.split("/") if p]
        for i in range(len(parts)):
            sub = "/" + "/".join(parts[:i + 1])
            if sub not in nodes:
                node = {"path": sub, "name": parts[i],
                        "count": 0, "total_size": 0, "children": []}
                nodes[sub] = node
                parent_path = "/" + "/".join(parts[:i]) if i > 0 else ""
                if parent_path and parent_path in nodes:
                    nodes[parent_path]["children"].append(node)
                else:
                    roots.append(node)
            nodes[sub]["count"] += e["c"]
            nodes[sub]["total_size"] += e["total"]
    return roots


def media_counts_by_source() -> list[dict[str, Any]]:
    with _lock:
        rows = get_conn().execute(
            """SELECT m.source_id, m.kind, COUNT(*) c, COALESCE(SUM(m.size),0) total
               FROM media m JOIN sources s ON s.id = m.source_id
               WHERE s.enabled = 1
               GROUP BY m.source_id, m.kind"""
        ).fetchall()
    return rows_to_dicts(rows)


def query_history(limit: int = 60, offset: int = 0,
                  source_ids: list[int] | None = None) -> tuple[list[dict[str, Any]], int]:
    """观看历史：有进度的媒体，按最近观看时间降序。"""
    where, params = ["p.position > 1"], []
    if source_ids:
        where.append(f"m.source_id IN ({','.join('?' * len(source_ids))})")
        params += list(source_ids)
    clause = " WHERE " + " AND ".join(where)
    with _lock:
        conn = get_conn()
        total = conn.execute(
            f"""SELECT COUNT(*) c FROM progress p JOIN media m ON m.id = p.media_id{clause}""",
            params).fetchone()["c"]
        rows = conn.execute(
            f"""SELECT m.*, s.name AS source_name, s.color AS source_color,
                       p.position AS position, p.duration AS p_duration,
                       p.watched_at AS watched_at, p.finished AS finished,
                       (f.media_id IS NOT NULL) AS is_fav
                FROM progress p
                JOIN media m ON m.id = p.media_id
                JOIN sources s ON s.id = m.source_id
                LEFT JOIN favorites f ON f.media_id = m.id
                {clause}
                ORDER BY p.watched_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset]).fetchall()
    return rows_to_dicts(rows), total


# ---------------- progress / favorites ----------------

def get_progress(media_id: int) -> dict[str, Any] | None:
    with _lock:
        row = get_conn().execute("SELECT * FROM progress WHERE media_id = ?", (media_id,)).fetchone()
    return dict(row) if row else None


def all_progress(min_position: float = 1.0) -> dict[int, float]:
    with _lock:
        rows = get_conn().execute(
            "SELECT media_id, position FROM progress WHERE position > ?", (min_position,)
        ).fetchall()
    return {r["media_id"]: r["position"] for r in rows}


def save_progress(media_id: int, position: float, duration: float = 0.0) -> None:
    finished = 1 if duration > 0 and position >= duration - 10 else 0
    with _lock:
        get_conn().execute(
            """INSERT INTO progress (media_id, position, duration, watched_at, finished)
               VALUES (?,?,?,?,?)
               ON CONFLICT(media_id) DO UPDATE SET
                 position=excluded.position, duration=excluded.duration,
                 watched_at=excluded.watched_at, finished=excluded.finished""",
            (media_id, float(position), float(duration), int(time.time()), finished),
        )
        get_conn().commit()


def clear_progress(media_id: int) -> None:
    with _lock:
        get_conn().execute("DELETE FROM progress WHERE media_id = ?", (media_id,))
        get_conn().commit()


def clear_all_progress() -> int:
    with _lock:
        cur = get_conn().execute("DELETE FROM progress")
        get_conn().commit()
    return cur.rowcount


def toggle_favorite(media_id: int) -> bool:
    with _lock:
        conn = get_conn()
        row = conn.execute("SELECT 1 FROM favorites WHERE media_id = ?", (media_id,)).fetchone()
        if row:
            conn.execute("DELETE FROM favorites WHERE media_id = ?", (media_id,))
            fav = False
        else:
            conn.execute("INSERT INTO favorites (media_id, created_at) VALUES (?,?)",
                         (media_id, int(time.time())))
            fav = True
        conn.commit()
    return fav


def is_favorite(media_id: int) -> bool:
    with _lock:
        return get_conn().execute(
            "SELECT 1 FROM favorites WHERE media_id = ?", (media_id,)
        ).fetchone() is not None


# ---------------- 配置导入导出（跨实例的稳定键）----------------

def find_source_by_key(base_url: str, root_path: str) -> dict[str, Any] | None:
    """按 (base_url, root_path) 找源。media_id 是本地自增的，跨实例不可用；
    源的「地址 + 根路径」才是稳定身份。"""
    base = (base_url or "").rstrip("/")
    root = root_path or "/"
    with _lock:
        row = get_conn().execute(
            "SELECT * FROM sources WHERE base_url = ? AND COALESCE(root_path, '/') = ?",
            (base, root)).fetchone()
    return dict(row) if row else None


def media_ids_by_path(source_id: int, paths: list[str]) -> dict[str, int]:
    """批量把 remote_path 解析成 media_id（导入收藏/进度时用）。"""
    out: dict[str, int] = {}
    clean = [p for p in dict.fromkeys(paths) if p]
    if not clean:
        return out
    with _lock:
        conn = get_conn()
        for i in range(0, len(clean), 400):
            chunk = clean[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for r in conn.execute(
                    f"SELECT id, remote_path FROM media "
                    f"WHERE source_id = ? AND remote_path IN ({ph})",
                    [source_id, *chunk]):
                out[r["remote_path"]] = r["id"]
    return out


def add_favorite(media_id: int, created_at: int | None = None) -> bool:
    """幂等加收藏。已存在返回 False（不覆盖原收藏时间）。"""
    with _lock:
        cur = get_conn().execute(
            "INSERT OR IGNORE INTO favorites (media_id, created_at) VALUES (?,?)",
            (media_id, int(created_at or time.time())))
        get_conn().commit()
    return cur.rowcount > 0


def export_favorites() -> list[dict[str, Any]]:
    with _lock:
        rows = get_conn().execute(
            """SELECT s.base_url, COALESCE(s.root_path,'/') AS root_path,
                      m.remote_path, f.created_at
               FROM favorites f
               JOIN media m ON m.id = f.media_id
               JOIN sources s ON s.id = m.source_id""").fetchall()
    return rows_to_dicts(rows)


def export_progress() -> list[dict[str, Any]]:
    with _lock:
        rows = get_conn().execute(
            """SELECT s.base_url, COALESCE(s.root_path,'/') AS root_path,
                      m.remote_path, p.position, p.duration, p.watched_at, p.finished
               FROM progress p
               JOIN media m ON m.id = p.media_id
               JOIN sources s ON s.id = m.source_id
               WHERE p.position > 1""").fetchall()
    return rows_to_dicts(rows)


def set_progress_exact(media_id: int, position: float, duration: float,
                       watched_at: int, finished: int) -> None:
    """按导入的原始值写入进度（save_progress 会重算 finished 和 watched_at，
    恢复备份时应尽量保留原样）。"""
    with _lock:
        get_conn().execute(
            """INSERT INTO progress (media_id, position, duration, watched_at, finished)
               VALUES (?,?,?,?,?)
               ON CONFLICT(media_id) DO UPDATE SET
                 position=excluded.position, duration=excluded.duration,
                 watched_at=excluded.watched_at, finished=excluded.finished""",
            (media_id, float(position or 0), float(duration or 0),
             int(watched_at or time.time()), 1 if finished else 0))
        get_conn().commit()


# ---------------- settings ----------------

def get_setting(key: str, default: Any = None) -> Any:
    with _lock:
        row = get_conn().execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return row["value"]


def set_setting(key: str, value: Any) -> None:
    with _lock:
        get_conn().execute(
            "INSERT INTO meta (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )
        get_conn().commit()


def stats() -> dict[str, Any]:
    with _lock:
        conn = get_conn()
        one = lambda q: conn.execute(q).fetchone()[0]
        # 媒体统计只计启用源 —— 停用源的内容不应出现在任何视图
        return {
            "sources": one("SELECT COUNT(*) FROM sources"),
            "sources_enabled": one("SELECT COUNT(*) FROM sources WHERE enabled=1"),
            "media": one("SELECT COUNT(*) FROM media m JOIN sources s ON s.id=m.source_id WHERE s.enabled=1"),
            "videos": one("SELECT COUNT(*) FROM media m JOIN sources s ON s.id=m.source_id WHERE s.enabled=1 AND m.kind='video'"),
            "images": one("SELECT COUNT(*) FROM media m JOIN sources s ON s.id=m.source_id WHERE s.enabled=1 AND m.kind='image'"),
            "audio": one("SELECT COUNT(*) FROM media m JOIN sources s ON s.id=m.source_id WHERE s.enabled=1 AND m.kind='audio'"),
            "total_size": one("SELECT COALESCE(SUM(m.size),0) FROM media m JOIN sources s ON s.id=m.source_id WHERE s.enabled=1"),
            "favorites": one("SELECT COUNT(*) FROM favorites"),
            "watched": one("SELECT COUNT(*) FROM progress WHERE position > 5"),
        }
