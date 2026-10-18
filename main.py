#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WebSua - 云刷 — 多 WebDAV 视频流播放器启动脚本。

用法：
    python main.py              # 启动服务（不自动开浏览器）
    python main.py --browser    # 启动并自动打开浏览器
    python main.py --port 9000  # 指定端口
    python main.py --host 0.0.0.0   # 允许局域网访问
    python main.py --scan           # 启动后立即全量扫描所有启用的数据源

仅依赖 Python 标准库，无需 pip install。
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import webbrowser

if sys.version_info < (3, 9):
    sys.stderr.write("需要 Python 3.9 或更高版本，当前为 %s\n" % sys.version.split()[0])
    sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend import db, scanner            # noqa: E402
from backend.server import serve          # noqa: E402

BANNER = r"""
  ___      __     ___   _
 | _ \__ _/ \___| | | |___ _ _
 | _ / _` (_-<_-<| | | / _ (_-<
 |_| \__,_/__/__/|_|_|_\____\__|
"""


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


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main() -> int:
    ap = argparse.ArgumentParser(description="WebSua 多 WebDAV 视频流播放器")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    ap.add_argument("--port", type=int, default=8770, help="端口（被占用时自动顺延）")
    ap.add_argument("--browser", action="store_true", help="启动后自动打开浏览器")
    ap.add_argument("--scan", action="store_true", help="启动后立即扫描所有数据源")
    args = ap.parse_args()

    # 允许双击运行时从任意目录启动
    if not os.path.isdir(os.path.join(os.getcwd(), "frontend")):
        os.chdir(os.path.dirname(os.path.abspath(__file__)))

    print(BANNER)
    print("  WebSua - 云刷 · 多 WebDAV 视频流 · 三端自适应 · 明暗主题\n")

    db.get_conn()  # 初始化数据库
    port = find_port(args.host, args.port)
    if port != args.port:
        print(f"  端口 {args.port} 被占用，改用 {port}\n")

    httpd = serve(args.host, port)

    url = f"http://127.0.0.1:{port}"
    print(f"  ▶ 打开 {url}")
    if args.host == "0.0.0.0":
        print(f"  ▶ 局域网访问 http://{lan_ip()}:{port}")
    print("  ▶ 按 Ctrl+C 退出\n")

    if args.scan:
        tasks = scanner.scan_all_enabled()
        print(f"  已启动 {len(tasks)} 个扫描任务\n")

    if args.browser:
        threading.Thread(target=lambda: (time.sleep(0.8), webbrowser.open(url)),
                         daemon=True).start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n  已停止。")
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
