#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WebSua 一键演示 —— 不需要网盘账号，一条命令看到完整界面。

    python demo.py                 # 起演示实例并自动打开浏览器
    python demo.py --no-browser    # 只起服务（服务器/容器里用）
    python demo.py --port 8780 --dav-port 8897
    python demo.py --reset         # 清空演示数据后重新开始

它做的事：
  1) 在本机起一个只读的假 WebDAV（素材由仓库内的真实样例视频拼成，
     Range 请求、封面、字幕都能真的播放，不是假数据）
  2) 用**独立的演示数据目录**（默认 data-demo/）启动 WebSua，
     绝不碰你的真实数据 data/
  3) 自动建两个演示数据源并扫描完，预置少量收藏与观看进度
  4) 打开浏览器

演示数据可以随时删掉：python demo.py --reset，或直接删除 data-demo/ 目录。
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA = os.path.join(ROOT, "data-demo")
REAL_DATA = os.path.join(ROOT, "data")

# 输出被重定向到文件/管道时，默认的块缓冲会让提示「憋住」不显示，
# 演示脚本的提示是给人看的，宁可牺牲一点性能也要实时打印。
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

# 演示用的字幕（与视频同名即自动关联）
DEMO_SRT = """1
00:00:00,000 --> 00:00:02,000
这是演示字幕：与视频同名的 .srt 会被自动关联

2
00:00:02,200 --> 00:00:05,000
播放器里可以开关字幕、调整字号与延迟

3
00:00:05,200 --> 00:00:08,000
更多用法见 docs/USAGE.md
"""

DEMO_TIP = """这是 WebSua 的一键演示环境
================================

所有内容都来自本机的一个假 WebDAV：目录结构由程序生成，
视频是仓库里几个几秒钟的样例片段（真的能播，Range 请求也真的生效）。

可以试试：
  · 电影卡片上的「继续观看」—— 演示实例预置了观看进度
  · 打开剧集《星尘纪事》的任意一集，播完自动接下一集（播放队列）
  · 播放器里切换字幕、拖动进度条（拖到中段也能秒开）
  · 顶栏切到「资料库」按目录筛选、搜索、排序
  · 设置里导出一次配置备份，看看备份文件长什么样

本文件本身不会被索引（.txt 不是媒体文件），放在目录里只是方便你翻看。
演示数据随时可清空：python demo.py --reset
"""

EXT_MIME = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".srt": "application/x-subrip", ".vtt": "text/vtt",
    ".txt": "text/plain; charset=utf-8",
}


def find_port(host: str, want: int, tries: int = 20) -> int:
    for i in range(tries):
        port = want + i
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    return want


def load_fixtures() -> tuple[dict[str, bytes], dict[str, bytes]]:
    """读取 tests/fixtures 下的真实样例视频与封面（仓库自带，无需额外下载）。"""
    fdir = os.path.join(ROOT, "tests", "fixtures")
    vids: dict[str, bytes] = {}
    pics: dict[str, bytes] = {}
    if not os.path.isdir(fdir):
        return vids, pics
    for fn in sorted(os.listdir(fdir)):
        p = os.path.join(fdir, fn)
        if not os.path.isfile(p):
            continue
        stem, ext = os.path.splitext(fn)
        ext = ext.lower()
        if ext not in (".webm", ".jpg", ".jpeg", ".png"):
            continue
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if ext == ".webm":
            vids[stem] = data
        else:
            pics[stem] = data
    return vids, pics


def build_demo_tree() -> dict[str, tuple[bytes, str]]:
    """构造演示目录树。返回 fake_dav 需要的 {远端路径: (内容, MIME)}。

    优先用真实样例视频 —— 随机字节浏览器解不了码，那样「一键试用」会变成
    「一键黑屏」。样例缺失时降级为占位字节，并在控制台说清楚。
    """
    vids, pics = load_fixtures()
    ordered = sorted(vids.items(), key=lambda kv: kv[0])
    files: dict[str, tuple[bytes, str]] = {}

    if ordered:
        # 按文件名配对封面：动画 紫金.webm ↔ 动画 紫金.jpg
        stems = [k for k, _ in ordered]
        v_main, v_alt = vids[stems[0]], vids[stems[1] if len(stems) > 1 else stems[0]]
        v_ep = vids[stems[2] if len(stems) > 2 else stems[0]]
        pic_main = pics.get(stems[0])
        pic_alt = pics.get(stems[1]) if len(stems) > 1 else pic_main
        pic_ep = pics.get(stems[2]) if len(stems) > 2 else pic_main
    else:
        v_main = bytes(os.urandom(200_000))
        v_alt = v_ep = v_main
        pic_main = pic_alt = pic_ep = None
        print("  ! 未找到 tests/fixtures 样例视频，演示视频无法播放（仅界面可看）")

    def put(path: str, data: bytes) -> None:
        ext = os.path.splitext(path)[1].lower()
        files[path] = (data, EXT_MIME.get(ext, "application/octet-stream"))

    # 电影（含同名字幕 + 同名封面，验证 TG 导出式封面与字幕关联）
    put("/演示库/电影/星际漫游.webm", v_main)
    if pic_main:
        put("/演示库/电影/星际漫游.jpg", pic_main)
    put("/演示库/电影/星际漫游.srt", DEMO_SRT.encode("utf-8"))
    put("/演示库/电影/深蓝回声.webm", v_alt)
    if pic_alt:
        put("/演示库/电影/深蓝回声.jpg", pic_alt)

    # 剧集：一整季，验证目录自然序播放队列（第2集在第10集之前）
    for i in range(1, 6):
        put(f"/演示库/剧集/星尘纪事/第{i:02d}集.webm", v_ep)

    # 短片（第二个数据源的根目录，验证多源并存）
    put("/演示库/短片/红色剪影.webm", v_ep)
    if pic_ep:
        put("/演示库/短片/红色剪影.jpg", pic_ep)

    # 相册：一张不重名的照片，验证图片单独成项（不会被当成谁的封面吃掉）
    if pic_main:
        put("/演示库/相册/旅行照片.jpg", pic_main)

    put("/演示库/说明/使用提示.txt", DEMO_TIP.encode("utf-8"))
    return files


def reset_demo_data(data_dir: str) -> None:
    """清掉演示数据。

    只允许清「默认演示目录」——万一有人把 --data 指到真实数据目录，
    这里必须拒绝，不能因为一条 --reset 把用户的媒体库删了。
    """
    real = os.path.abspath(data_dir)
    if real != os.path.abspath(DEFAULT_DATA):
        print(f"  ✗ 为安全起见，--reset 只清默认演示目录：{DEFAULT_DATA}")
        print(f"    当前 --data 指向 {real}，请自行删除该目录。")
        sys.exit(2)
    if not os.path.isdir(real):
        print("  演示数据本来就不存在，无需清理。")
        return
    removed = 0
    for name in os.listdir(real):
        # 只删演示实例自己会写的那几个文件，不做整目录 rmtree
        if name.startswith("library.db") or name == "scan.log":
            os.remove(os.path.join(real, name))
            removed += 1
    print(f"  已清空演示数据（{removed} 个文件）：{real}")


def main() -> int:
    ap = argparse.ArgumentParser(description="WebSua 一键演示（本地假 WebDAV，无需账号）")
    ap.add_argument("--port", type=int, default=8780, help="演示实例端口（默认 8780）")
    ap.add_argument("--dav-port", type=int, default=8897, help="假 WebDAV 端口（默认 8897）")
    ap.add_argument("--data", default=DEFAULT_DATA, help="演示数据目录（默认 data-demo/）")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--reset", action="store_true", help="清空演示数据后退出")
    args = ap.parse_args()

    data_dir = os.path.abspath(args.data)
    if data_dir == os.path.abspath(REAL_DATA):
        print("  ✗ 演示实例不能使用真实数据目录 data/，请换一个 --data。")
        return 2

    if args.reset:
        reset_demo_data(data_dir)
        return 0

    # 必须在 import backend.config 之前设好 —— 数据目录是导入时读的
    os.environ["WEBSUA_DATA"] = data_dir
    # 演示目录只有几个，不需要为防限流而等待；用户显式设置过则不覆盖
    os.environ.setdefault("WEBSUA_SCAN_RATE", "0.02")

    os.chdir(ROOT)
    sys.path.insert(0, ROOT)
    sys.path.insert(0, os.path.join(ROOT, "tests"))

    import fake_dav                                    # noqa: E402
    from backend import db, scanner                     # noqa: E402
    from backend.server import serve                    # noqa: E402

    os.makedirs(data_dir, exist_ok=True)

    print("""
  WebSua 一键演示
  ================
  正在准备本地假 WebDAV 与演示数据…""")

    dav_port = find_port("127.0.0.1", args.dav_port)
    files = build_demo_tree()
    fake_dav.serve(dav_port, builder=lambda: files)
    dav_base = f"http://127.0.0.1:{dav_port}/dav"

    db.get_conn()

    # ---- 建演示源（两个：整库 + 单目录，展示多源并存）----
    # tg_mode 打开：演示目录按「视频同名 .jpg 即封面」组织，与 Telegram 导出
    # 结构一致 —— 这样界面上每张卡片都有真封面，而不是一片灰底占位图。
    def ensure_source(name: str, root_path: str, icon: str, color: str) -> int:
        for s in db.list_sources():
            if s["base_url"] == dav_base and s.get("root_path") == root_path:
                if not s.get("tg_mode"):
                    # 旧版演示目录留下的源：补上开关，否则升级后仍然没封面
                    db.update_source(s["id"], {"tg_mode": 1})
                return int(s["id"])
        return db.create_source({
            "name": name, "base_url": dav_base, "root_path": root_path,
            "kind": "video", "icon": icon, "color": color, "sort": 0,
            "auto_scan": False, "tg_mode": True,
        })

    sid_all = ensure_source("演示库", "/", "film", "#6C8CFF")
    sid_clip = ensure_source("短片收藏", "/演示库/短片/", "star", "#F2A65A")

    print("  正在扫描演示内容…")
    for sid in (sid_all, sid_clip):
        t = scanner.start_scan(sid, mode="full", async_=False)
        if t and t.get("state") == "failed":
            print(f"  ! 扫描失败：{t.get('error')}")

    # ---- 预置一点使用痕迹，界面才不会空荡荡 ----
    try:
        ids = db.media_ids_by_path(sid_all, [
            "/演示库/电影/星际漫游.webm",
            "/演示库/电影/深蓝回声.webm",
            "/演示库/剧集/星尘纪事/第03集.webm",
        ])
        if ids.get("/演示库/电影/星际漫游.webm"):
            db.add_favorite(ids["/演示库/电影/星际漫游.webm"])
        if ids.get("/演示库/剧集/星尘纪事/第03集.webm"):
            db.set_progress_exact(ids["/演示库/剧集/星尘纪事/第03集.webm"],
                                  45.0, 120.0, int(time.time()) - 3600, 0)
        if ids.get("/演示库/电影/深蓝回声.webm"):
            db.set_progress_exact(ids["/演示库/电影/深蓝回声.webm"],
                                  120.0, 120.0, int(time.time()) - 86400, 1)
    except Exception as e:                                # 演示环境不该因预置失败而退出
        print(f"  ! 预置示例收藏/进度失败（不影响使用）：{e}")

    total = db.count_media_by_source(sid_all) + db.count_media_by_source(sid_clip)

    # 扫完再开端口：浏览器打开时内容已经在库里，不会先看到一片空白再「蹦」出来。
    # 也让「端口通了」等价于「演示就绪」，外部脚本判断更简单。
    port = find_port("127.0.0.1", args.port)
    httpd = serve("127.0.0.1", port)
    url = f"http://127.0.0.1:{port}"

    print(f"""
  ✓ 演示就绪：{total} 个媒体文件，2 个数据源
  ▶ 打开 {url}
  ▶ 演示数据目录 {data_dir}（与真实数据 data/ 完全隔离）
  ▶ 清空演示数据：python demo.py --reset
  ▶ 按 Ctrl+C 退出
""")

    if not args.no_browser:
        threading.Thread(target=lambda: (time.sleep(0.6), webbrowser.open(url)),
                         daemon=True).start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n  已停止（演示数据保留，下次启动秒开）。")
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
