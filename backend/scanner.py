"""扫描任务：把 WebDAV 目录树同步进 SQLite。"""
from __future__ import annotations

import threading
import time
import traceback
from typing import Any

from . import db
from .config import (SCAN_MAX_DEPTH, SCAN_LOG_PATH, SCAN_LOG_MAX_BYTES,
                     SCAN_LOG_EVERY_DIRS, SCAN_LOG_EVERY_FILES)
from .webdav import WebDAVClient, WebDAVError, make_client

_tasks: dict[int, dict[str, Any]] = {}
_tasks_lock = threading.RLock()
_task_seq = 0
_log_lock = threading.Lock()


def scan_log(level: str, source_id: int, msg: str) -> None:
    """写扫描日志到 data/scan.log（带轮转），并追加到对应任务的 log 列表。"""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] [src={source_id}] {msg}"
    try:
        with _log_lock:
            if SCAN_LOG_PATH.exists() and SCAN_LOG_PATH.stat().st_size > SCAN_LOG_MAX_BYTES:
                try:
                    SCAN_LOG_PATH.replace(SCAN_LOG_PATH.with_suffix(".old"))
                except OSError:
                    pass
            with open(SCAN_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        pass
    with _tasks_lock:
        for t in _tasks.values():
            if t.get("source_id") == source_id:
                logs = t.setdefault("logs", [])
                logs.append(line)
                if len(logs) > 200:
                    del logs[:100]


def _match_posters(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """TG 导出结构：视频带附属缩略图。

    实测命名（Telegram 导出）：
      1 (3).mp4 + 1 (3).mp4_thumb.jpg    （视频全名 + _thumb.jpg，主规则）
    兼容其他工具的两种命名：
      video.mp4  +  video.jpg            （同名不同扩展）
      video.mp4  +  video.mp4.jpg        （原名 + .jpg）

    匹配成功的缩略图**从媒体列表中剔除**——它是视频的附属品，单独显示
    只是噪音；普通图片消息（photo_xxx.jpg）不会撞上视频名，不受影响。
    """
    import os as _os

    IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
    THUMB_SUFFIX = "_thumb"
    # 目录 -> {键: 图片条目}；键可以是「视频全名」或「视频 stem（去扩展名）」
    images: dict[str, dict[str, Any]] = {}
    for it in items:
        if it.get("kind") != "image" or it.get("ext") not in IMG_EXTS:
            continue
        folder = it.get("folder", "")
        stem = _os.path.splitext(it["name"])[0]     # 1 (3).mp4_thumb
        inner = _os.path.splitext(stem)[0]          # 1 (3).mp4
        bucket = images.setdefault(folder, {})
        if stem.endswith(THUMB_SUFFIX):
            base = stem[: -len(THUMB_SUFFIX)]       # 1 (3).mp4 —— 视频全名
            bucket.setdefault(base, it)             # 主规则：按视频全名匹配
            bucket.setdefault(_os.path.splitext(base)[0], it)
        bucket.setdefault(stem, it)                 # 兼容：video.jpg 按视频 stem 匹配
        if inner and inner != stem:
            bucket.setdefault(inner, it)            # 兼容：video.mp4.jpg

    used: set[int] = set()
    matched = 0
    for it in items:
        if it.get("kind") not in ("video", "audio"):
            continue
        bucket = images.get(it.get("folder", ""), {})
        if not bucket:
            continue
        poster = bucket.get(it["name"]) or bucket.get(_os.path.splitext(it["name"])[0])
        if poster is not None and id(poster) != id(it):
            it["poster_path"] = poster["remote_path"]
            used.add(id(poster))
            matched += 1

    # 剔除已作为封面的缩略图
    if used:
        items = [it for it in items
                 if not (it.get("kind") == "image" and id(it) in used)]
        scan_log("info", 0, f"TG 封面匹配：{matched} 个视频关联封面，剔除 {len(used)} 张附属缩略图")
    return items


def _match_subtitles(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把同目录同名字幕关联到视频/音频上（与 TG 封面匹配同一思路）。

    支持命名：
      片名.mp4 + 片名.srt        （主规则：同名不同扩展名）
      片名.mp4 + 片名.mp4.srt    （视频全名 + .srt）

    字幕是附属品：匹配上的从媒体列表剔除，**未匹配的一并剔除**——
    没有视频的字幕单独显示只是噪音。.ass/.ssa 不在扫描范围内
    （config.SUBTITLE_KIND_EXTS 只含 .srt/.vtt，前端会提示不支持）。
    """
    import os as _os

    SUB_EXTS = {".srt", ".vtt"}
    # 目录 -> {键: 字幕条目}；键是「视频 stem（去扩展名）」或「视频全名」
    subs: dict[str, dict[str, dict[str, Any]]] = {}
    for it in items:
        if it.get("kind") != "subtitle" or it.get("ext") not in SUB_EXTS:
            continue
        bucket = subs.setdefault(it.get("folder", ""), {})
        stem = _os.path.splitext(it["name"])[0]      # 片名  或  片名.mp4
        bucket.setdefault(stem, it)
        inner = _os.path.splitext(stem)[0]
        if inner and inner != stem:
            bucket.setdefault(inner, it)             # 片名.mp4.srt -> 键「片名」

    matched = 0
    for it in items:
        if it.get("kind") not in ("video", "audio"):
            continue
        bucket = subs.get(it.get("folder", ""), {})
        if not bucket:
            continue
        sub = (bucket.get(_os.path.splitext(it["name"])[0])
               or bucket.get(it["name"]))
        if sub is not None and id(sub) != id(it):
            it["subtitle_path"] = sub["remote_path"]
            matched += 1

    items = [it for it in items if it.get("kind") != "subtitle"]
    if matched:
        scan_log("info", 0, f"字幕匹配：{matched} 个视频关联字幕，字幕文件不单独入媒体库")
    return items


def _next_id() -> int:
    global _task_seq
    with _tasks_lock:
        _task_seq += 1
        return _task_seq


def create_task(source_id: int, kind: str = "full") -> dict[str, Any]:
    task = {
        "id": _next_id(), "source_id": source_id, "kind": kind,
        "state": "pending", "found": 0, "folders": 0, "error": "",
        "control": "run",       # run | pause | cancel —— 扫描控制
        "started_at": time.time(), "finished_at": None,
    }
    with _tasks_lock:
        _tasks[task["id"]] = task
    return task


def control_task(source_id: int, action: str) -> dict[str, Any] | None:
    """暂停 / 继续 / 取消某个源的扫描。返回受影响的任务，无任务则 None。

    pause/cancel 只是设标志，真正标记 state 的是扫描线程（要到下一个
    检查点，最长 0.25s 限流间隔 + 网络）。这里设完标志后在锁外短等
    线程确认，让前端第一次拉取就能拿到 paused/cancelled，UI 即时反馈。
    """
    tid = None
    with _tasks_lock:
        for t in _tasks.values():
            if t["source_id"] == source_id and t["state"] in ("pending", "running", "paused"):
                if action == "pause":
                    t["control"] = "pause"
                elif action == "resume":
                    t["control"] = "run"
                    t["state"] = "running"
                elif action == "cancel":
                    t["control"] = "cancel"
                scan_log("info", source_id,
                         f"控制操作 action={action} 任务#{t['id']} state={t['state']}")
                tid = t["id"]
                break
    if tid is None:
        return None

    if action in ("pause", "cancel"):
        deadline = time.time() + 1.2
        while time.time() < deadline:
            with _tasks_lock:
                t = _tasks.get(tid)
                if t and t["state"] in ("paused", "cancelled", "done"):
                    return dict(t)
            time.sleep(0.04)

    with _tasks_lock:
        t = _tasks.get(tid)
        return dict(t) if t else None


def get_task(task_id: int) -> dict[str, Any] | None:
    with _tasks_lock:
        t = _tasks.get(task_id)
        return dict(t) if t else None


def active_task_for(source_id: int) -> dict[str, Any] | None:
    """活动任务 = 待开始 / 运行中 / 已暂停。

    paused 必须算活动：否则暂停期间还能再开新扫描，出现双任务导致控制错乱
    （一个僵尸暂停 + 一个新任务，pause/resume 作用到僵尸上）。
    """
    with _tasks_lock:
        for t in _tasks.values():
            if t["source_id"] == source_id and t["state"] in ("pending", "running", "paused"):
                return dict(t)
    return None


def list_tasks() -> list[dict[str, Any]]:
    """最近任务，按 id 降序。**每个源只保留最新一条** ——
    同源历史任务全留着的话，消费端按 source_id 做 key 会互相覆盖。"""
    with _tasks_lock:
        ordered = sorted(_tasks.values(), key=lambda t: -t["id"])[:50]
    seen: set[int] = set()
    out: list[dict[str, Any]] = []
    for t in ordered:
        if t["source_id"] in seen:
            continue
        seen.add(t["source_id"])
        out.append(dict(t))
    return out


def prune_tasks(keep: int = 100) -> None:
    with _tasks_lock:
        if len(_tasks) > keep:
            for tid in sorted(_tasks.keys())[:-keep]:
                del _tasks[tid]


def scan_source(source_id: int, task_id: int) -> None:
    src = db.get_source(source_id)
    if not src:
        with _tasks_lock:
            _tasks[task_id]["state"] = "failed"
            _tasks[task_id]["error"] = "数据源不存在"
        return

    with _tasks_lock:
        _tasks[task_id]["state"] = "running"
        _tasks[task_id]["error"] = ""

    t0 = time.time()
    client: WebDAVClient = make_client(src)
    root = src.get("root_path") or "/"
    exclude = {x.strip() for x in (src.get("exclude_dirs") or "").replace("，", ",").split(",") if x.strip()}
    scan_log("info", source_id,
             f"开始扫描 root={root} depth={SCAN_MAX_DEPTH}"
             + (f" 排除目录={','.join(sorted(exclude))}" if exclude else ""))

    failed_dirs: list[tuple[str, str]] = []
    progress_marks = {"dirs": 0, "files": 0}   # 上次记进度时的数值

    def on_progress(folders_done: int, path: str) -> None:
        with _tasks_lock:
            _tasks[task_id]["folders"] = folders_done
            _tasks[task_id]["current"] = path
        # 周期性进度日志：TB 级扫描动辄几十分钟，没有日志用户无从判断
        # 是在干活还是卡死了（每 25 个目录记一条）
        if folders_done - progress_marks["dirs"] >= SCAN_LOG_EVERY_DIRS:
            progress_marks["dirs"] = folders_done
            with _tasks_lock:
                found = _tasks[task_id].get("found", 0)
            scan_log("info", source_id,
                     f"进度：已遍历 {folders_done} 目录 · 已发现 {found} 文件 · 当前 {path}")

    def on_dir_error(path: str, err: str) -> None:
        """目录列举失败：绝不静默——整个子树的文件都会消失。"""
        failed_dirs.append((path, err))
        scan_log("error", source_id, f"目录列举失败（该目录及其子目录被跳过）：{path} — {err}")

    def on_found(count: int) -> None:
        # 每 500 个文件记一条进度（on_progress 只按目录节拍）
        if count - progress_marks["files"] >= SCAN_LOG_EVERY_FILES:
            progress_marks["files"] = count
            with _tasks_lock:
                folders_done = _tasks[task_id].get("folders", 0)
            scan_log("info", source_id,
                     f"进度：已遍历 {folders_done} 目录 · 已发现 {count} 文件")

    def control() -> str:
        with _tasks_lock:
            return _tasks.get(task_id, {}).get("control", "run")

    def wait_if_paused() -> None:
        """文件级暂停：挂起扫描线程直到恢复或取消。"""
        if control() == "pause":
            with _tasks_lock:
                if _tasks[task_id].get("state") != "paused":
                    _tasks[task_id]["state"] = "paused"
                    scan_log("info", source_id, "扫描已暂停")
            while control() == "pause":
                time.sleep(0.15)
            # 只有真正恢复（control 变回 run）才写「继续」；
            # 期间被 cancel 时由主循环写「已取消」，这里不能再写「继续」误导排查
            if control() == "run":
                with _tasks_lock:
                    if _tasks[task_id].get("state") == "paused":
                        _tasks[task_id]["state"] = "running"
                        scan_log("info", source_id, "扫描已继续")

    def should_stop() -> bool:
        """目录级控制（生成器内部用，减少无效网络请求）。"""
        if control() == "cancel":
            return True
        wait_if_paused()
        return False

    try:
        collected: list[dict[str, Any]] = []
        cancelled = False
        for entry in client.list_tree(root, max_depth=SCAN_MAX_DEPTH,
                                      on_progress=on_progress, should_stop=should_stop,
                                      on_error=on_dir_error, exclude=exclude):
            # 文件级控制：暂停/取消必然生效（生成器的目录级检查可能错过时机）
            if control() == "cancel":
                cancelled = True
                break
            wait_if_paused()

            if entry["kind"] in ("video", "audio", "image", "subtitle"):
                collected.append({
                    "remote_path": entry["path"],
                    "name": entry["name"],
                    "ext": entry["ext"],
                    "kind": entry["kind"],
                    "mime": entry["mime"],
                    "size": entry["size"],
                    "mtime": entry["mtime"],
                    "folder": entry["folder"],
                })
            with _tasks_lock:
                _tasks[task_id]["found"] = len(collected)
            on_found(len(collected))   # 内部按 500 节流写日志

        # 被取消：不落库，直接标记 cancelled
        if cancelled or control() == "cancel":
            with _tasks_lock:
                _tasks[task_id].update({
                    "state": "cancelled", "found": len(collected),
                    "finished_at": time.time(),
                })
            scan_log("info", source_id, f"扫描已取消（已发现 {len(collected)} 个文件）")
            return

        items = collected
        # TG 导出封面：只有该源开启了 tg_mode 才做同名封面匹配
        if src.get("tg_mode"):
            items = _match_posters(items)
        # 字幕：同名 .srt / .vtt 关联到视频/音频（附属品，不单独入媒体库）
        items = _match_subtitles(items)
        added, total, removed = db.bulk_upsert_media(source_id, items)
        elapsed = int((time.time() - t0) * 1000)
        db.update_source(source_id, {
            "last_scan_at": int(time.time()), "last_scan_ms": elapsed,
            "last_error": "", "item_count": total,
        })
        scan_log("info", source_id,
                 f"扫描完成 文件={len(items)} 新增={added} 移除={removed} 耗时={elapsed}ms")
        if failed_dirs:
            scan_log("error", source_id,
                     f"⚠ 有 {len(failed_dirs)} 个目录列举失败被跳过（可能丢失大量文件），"
                     f"建议稍后重新扫描："
                     + "；".join(f"{p}（{err[:40]}）" for p, err in failed_dirs[:5])
                     + ("…" if len(failed_dirs) > 5 else ""))
        with _tasks_lock:
            _tasks[task_id].update({
                "state": "done", "found": len(items), "total": total,
                "added": added, "removed": removed,
                "failed_dirs": len(failed_dirs),
                "finished_at": time.time(), "elapsed_ms": elapsed,
            })
    except WebDAVError as e:
        db.update_source(source_id, {"last_error": str(e)})
        scan_log("error", source_id, f"扫描失败：{e}")
        with _tasks_lock:
            _tasks[task_id].update({"state": "failed", "error": str(e),
                                    "finished_at": time.time()})
    except Exception as e:  # noqa: BLE001
        db.update_source(source_id, {"last_error": f"内部错误：{e}"})
        scan_log("error", source_id, f"扫描内部错误：{e}")
        with _tasks_lock:
            _tasks[task_id].update({
                "state": "failed", "error": f"内部错误：{e}",
                "trace": traceback.format_exc()[-1500:],
                "finished_at": time.time(),
            })
    finally:
        prune_tasks()


def start_scan(source_id: int, async_: bool = True) -> dict[str, Any]:
    """启动扫描。async_=True 时后台线程执行。"""
    running = active_task_for(source_id)
    if running:
        return running
    task = create_task(source_id)
    if async_:
        threading.Thread(target=scan_source, args=(source_id, task["id"]),
                         daemon=True).start()
    else:
        scan_source(source_id, task["id"])
        return get_task(task["id"]) or task
    return task


def scan_all_enabled() -> list[dict[str, Any]]:
    return [start_scan(s["id"]) for s in db.list_sources(only_enabled=True)]


def start_auto_scans() -> None:
    """启动时对勾选了自动扫描的数据源做一次后台扫描。"""
    for s in db.list_sources(only_enabled=True):
        if s.get("auto_scan"):
            start_scan(s["id"])
