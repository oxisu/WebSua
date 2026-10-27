"""配置导入导出 / 备份。

打包内容：数据源配置、前端设置、收藏、观看进度。

**跨实例的关键**：收藏和进度在库里是 `media_id` 关联的，而 `media_id`
是本地自增的 —— 换一台机器 / 重建数据库后完全对不上。所以导出时一律
换成稳定键：

    源身份 = (base_url 规范化, root_path)
    条目身份 = (源身份, remote_path)

导入时按这个键在本地重新解析出 media_id 再写。没扫描过的媒体解析不到，
就跳过并计数（不编造、不静默丢弃）。

同时遵循「可恢复性必须成为设计考虑」：密码默认脱敏（只记 has_password），
需要时可显式包含；导入时不会用空密码覆盖已有密码。
"""
from __future__ import annotations

import time
from typing import Any

from . import db

EXPORT_VERSION = 1
APP_TAG = "WebSua"

# 导入时允许写回的源字段（不含 created_at / last_scan_* 等运行时状态）
SOURCE_FIELDS = (
    "name", "base_url", "root_path", "kind", "icon", "color", "sort",
    "enabled", "auto_scan", "verify_ssl", "tg_mode", "exclude_dirs", "username",
)


def _norm_base(url: str) -> str:
    return (url or "").strip().rstrip("/")


def _norm_root(root: str) -> str:
    return root or "/"


def export_config(include_passwords: bool = False) -> dict[str, Any]:
    """导出当前配置与观看数据（可直接 json.dumps）。"""
    sources: list[dict[str, Any]] = []
    for s in db.list_sources():
        item = {k: s.get(k) for k in SOURCE_FIELDS}
        item["root_path"] = _norm_root(s.get("root_path") or "/")
        item["sort"] = int(s.get("sort") or 0)
        item["enabled"] = 1 if s.get("enabled") else 0
        item["auto_scan"] = 1 if s.get("auto_scan") else 0
        item["tg_mode"] = 1 if s.get("tg_mode") else 0
        item["verify_ssl"] = 1 if s.get("verify_ssl", 1) else 0
        item["has_password"] = bool(s.get("password"))
        if include_passwords:
            item["password"] = s.get("password") or ""
        sources.append(item)

    favorites = [{
        "source_base_url": r["base_url"],
        "source_root": _norm_root(r.get("root_path")),
        "remote_path": r["remote_path"],
        "created_at": r.get("created_at"),
    } for r in db.export_favorites()]

    progress = [{
        "source_base_url": r["base_url"],
        "source_root": _norm_root(r.get("root_path")),
        "remote_path": r["remote_path"],
        "position": r.get("position") or 0,
        "duration": r.get("duration") or 0,
        "watched_at": r.get("watched_at"),
        "finished": 1 if r.get("finished") else 0,
    } for r in db.export_progress()]

    return {
        "app": APP_TAG,
        "version": EXPORT_VERSION,
        "exported_at": int(time.time()),
        "includes_passwords": bool(include_passwords),
        "sources": sources,
        "settings": db.get_setting("app") or {},
        "favorites": favorites,
        "progress": progress,
        "counts": {
            "sources": len(sources),
            "favorites": len(favorites),
            "progress": len(progress),
        },
    }


def _validated(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("备份内容不是合法的 JSON 对象")
    if data.get("app") and data.get("app") != APP_TAG:
        raise ValueError("这不是 WebSua 的备份文件")
    ver = data.get("version")
    if not isinstance(ver, int) or ver < 1:
        raise ValueError("备份文件缺少有效的 version 字段")
    if ver > EXPORT_VERSION:
        raise ValueError(
            f"备份版本 {ver} 高于当前程序支持的 {EXPORT_VERSION}，请先升级 WebSua")
    for key in ("sources", "favorites", "progress"):
        v = data.get(key)
        if v is not None and not isinstance(v, list):
            raise ValueError(f"{key} 字段必须是数组")
    if data.get("settings") is not None and not isinstance(data.get("settings"), dict):
        raise ValueError("settings 字段必须是对象")
    return data


def import_config(data: dict[str, Any]) -> dict[str, Any]:
    """导入配置与观看数据（合并语义，不删除已有数据）。

    返回汇总：源新增/更新、需要补密码的数量、收藏/进度恢复与跳过数量。
    """
    data = _validated(data)

    # ---- 1. 数据源：按 (base_url, root_path) 合并 ----
    src_added = src_updated = need_pw = 0
    for raw in data.get("sources") or []:
        if not isinstance(raw, dict):
            continue
        base = _norm_base(str(raw.get("base_url") or ""))
        if not base:
            continue
        root = _norm_root(str(raw.get("root_path") or "/"))
        payload = {k: raw.get(k) for k in SOURCE_FIELDS if raw.get(k) is not None}
        payload["base_url"] = base
        payload["root_path"] = root
        payload.setdefault("name", base)
        pw = raw.get("password")

        existing = db.find_source_by_key(base, root)
        if existing:
            upd = {k: v for k, v in payload.items() if k != "base_url"}
            # 绝不用空密码覆盖已有密码：脱敏导出后导入不该把密码清掉
            if pw:
                upd["password"] = pw
            elif raw.get("has_password") and not existing.get("password"):
                need_pw += 1
            db.update_source(existing["id"], upd)
            src_updated += 1
        else:
            if pw:
                # 新建源必须把密码带上 —— password 不在 SOURCE_FIELDS 里
                # （它属于敏感字段，单独处理），忘了这步会导致「含密码备份
                # 导入后密码丢失」
                payload["password"] = pw
            else:
                need_pw += 1     # 新源没密码：用户待补
            db.create_source(payload)
            src_added += 1

    # ---- 2. 设置：浅合并 ----
    settings = data.get("settings")
    if isinstance(settings, dict):
        cur = db.get_setting("app") or {}
        merged = dict(cur) if isinstance(cur, dict) else {}
        merged.update(settings)
        db.set_setting("app", merged)

    # ---- 3. 收藏 / 进度：按稳定键重新解析 media_id ----
    def _group(entries: list[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for e in entries:
            if not isinstance(e, dict):
                continue
            base = _norm_base(str(e.get("source_base_url") or e.get("base_url") or ""))
            root = _norm_root(str(e.get("source_root") or e.get("root_path") or "/"))
            if not base or not e.get("remote_path"):
                continue
            groups.setdefault((base, root), []).append(e)
        return groups

    fav_ok = fav_skip = 0
    for (base, root), entries in _group(data.get("favorites") or []).items():
        src = db.find_source_by_key(base, root)
        if not src:
            fav_skip += len(entries)
            continue
        idmap = db.media_ids_by_path(src["id"], [e["remote_path"] for e in entries])
        for e in entries:
            mid = idmap.get(e["remote_path"])
            if not mid:
                fav_skip += 1        # 远端条目还没扫描，无法恢复
                continue
            db.add_favorite(mid, e.get("created_at"))
            fav_ok += 1

    prog_ok = prog_skip = 0
    for (base, root), entries in _group(data.get("progress") or []).items():
        src = db.find_source_by_key(base, root)
        if not src:
            prog_skip += len(entries)
            continue
        idmap = db.media_ids_by_path(src["id"], [e["remote_path"] for e in entries])
        for e in entries:
            mid = idmap.get(e["remote_path"])
            if not mid:
                prog_skip += 1
                continue
            db.set_progress_exact(
                mid, e.get("position") or 0, e.get("duration") or 0,
                e.get("watched_at") or int(time.time()),
                int(e.get("finished") or 0))
            prog_ok += 1

    return {
        "sources_added": src_added,
        "sources_updated": src_updated,
        "sources_need_password": need_pw,
        "favorites_restored": fav_ok,
        "favorites_skipped": fav_skip,
        "progress_restored": prog_ok,
        "progress_skipped": prog_skip,
        "exported_at": data.get("exported_at"),
        "includes_passwords": bool(data.get("includes_passwords")),
    }
