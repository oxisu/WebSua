#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键运行全部测试：自动起假 WebDAV + 主服务，跑完自动清理。

    python tests/run_all.py

无需预先手动启动任何服务。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable

# 英文区域的 Windows 控制台是 cp1252，打印中文会 UnicodeEncodeError 把整个
# 测试跑挂掉。规则：
#   · 输出不是终端（CI 的 tee / 重定向到文件）→ 用 UTF-8，中文在日志里可读；
#   · 输出是终端 → 保持控制台原生编码，只把编码错误降级成替换字符。
for _s in (sys.stdout, sys.stderr):
    try:
        if not _s.isatty():
            _s.reconfigure(encoding="utf-8", errors="replace")
        else:
            _s.reconfigure(errors="replace")
    except Exception:
        pass

# 测试专用隔离实例 —— 绝不打用户的服务（8771/8899）和用户数据（data/）！
# 曾发生过：测试在主端口上「清掉旧数据」把用户刚配好的 123 源全删了。
PORT = 8792
DAV_PORT = 8898
# 测试数据目录：独立于用户数据，每次全套回归前清空重建
TEST_DATA_DIR = os.path.join(ROOT, "data-test")
PROCS: list[subprocess.Popen] = []


def kill_port(port: int) -> None:
    """杀掉占用端口的进程（跨平台）。

    Windows 必须做：Windows 的 SO_REUSEADDR 允许两个进程同时 bind 同一端口，
    残留的旧假服务器会让新启动的 auth 模式进程变成「影子」，请求全被旧进程接走。
    Linux/macOS（CI）用 lsof 找 PID —— 之前只会调 netstat/taskkill，
    在 runner 上必然失败，等于每次 CI 都带着残留进程跑。
    """
    if os.name == "nt":
        _kill_port_windows(port)
    else:
        _kill_port_posix(port)


def _kill_port_windows(port: int) -> None:
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=10).stdout
    except Exception:
        return
    pids = set()
    for line in (out or "").splitlines():
        parts = line.split()
        # TCP  127.0.0.1:8899  0.0.0.0:0  LISTENING  1234
        if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
            try:
                pids.add(int(parts[4]))
            except ValueError:
                pass
    for pid in pids:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                       capture_output=True, timeout=10)


def _kill_port_posix(port: int) -> None:
    import signal

    try:
        out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return
    for line in (out or "").splitlines():
        line = line.strip()
        if not line.isdigit():
            continue
        try:
            os.kill(int(line), signal.SIGKILL)
        except OSError:
            pass


def wait_port(port: int, timeout: float = 15.0) -> bool:
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with op.open(f"http://127.0.0.1:{port}/api/health", timeout=2):
                return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(0.25)
    return False


def _open_log(name: str):
    """以追加方式打开 data-test/<name>，用于接子进程输出。"""
    os.makedirs(TEST_DATA_DIR, exist_ok=True)
    return open(os.path.join(TEST_DATA_DIR, name), "ab")


def dump_tail(path: str, lines: int = 25) -> None:
    """打印日志尾部。CI 上只给退出码没法排障，必须把「为什么」打出来。"""
    try:
        with open(path, "rb") as f:
            data = f.read()[-6000:]
    except OSError:
        return
    text = data.decode("utf-8", "replace").strip()
    if not text:
        print(f"  --- {os.path.basename(path)} 是空的（进程可能没起来就退出了）---")
        return
    print(f"  --- {os.path.basename(path)} 末尾 {lines} 行 ---")
    for line in text.splitlines()[-lines:]:
        print("  | " + line)


def run(name: str, args: list[str], timeout: float = 300) -> bool:
    """跑一个套件。

    timeout 是**必须**的：某个套件在特定平台（实测 macOS CI）卡住时，没有超时
    就会把整个 job 拖到 25 分钟上限，什么信息都留不下。超时至少能说清「卡在哪套」。
    """
    print(f"\n{'#' * 62}\n# {name}\n{'#' * 62}")
    try:
        r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"  [FAIL] 超时：{timeout:.0f}s 内没有跑完（进程被强杀）")
        return False
    out = (r.stdout or "") + (r.stderr or "")
    # 只打结果行，避免刷屏
    for line in out.splitlines():
        if any(k in line for k in ("[PASS]", "[FAIL]", "结果：", "场景", "====")):
            if line.strip().startswith("=") or "结果" in line or line.strip().startswith(("场景", "服务器")):
                continue
            print("  " + line.strip())
        elif "Traceback" in line:
            print("  " + line.strip())
    summary = [l for l in out.splitlines() if "结果：" in l]
    if summary:
        print("  → " + summary[-1].strip())
    return r.returncode == 0


def main() -> int:
    print("启动测试环境（隔离数据目录 data-test，与用户数据完全隔离）…")
    # 注意：这里不主动清库——每个测试自带清场（test_e2e 清源、test_edge
    # clear_sources、浏览器测试各自清场），库残留不影响正确性。
    os.makedirs(TEST_DATA_DIR, exist_ok=True)

    # 先清掉残留进程，避免 Windows 双绑定导致新旧服务器互相干扰
    kill_port(DAV_PORT)
    kill_port(PORT)
    time.sleep(0.3)
    env = {**os.environ, "WEBSUA_DATA": TEST_DATA_DIR}
    # 子进程输出落盘：本地调试可回看，CI 上「起不来」时也能打印尾部说明原因。
    # 用 -u 关掉子进程的输出缓冲 —— 否则崩溃前打的东西全在缓冲区里，日志是空的。
    dav_log = _open_log("fake-dav.log")
    main_log = _open_log("main.log")
    PROCS.append(subprocess.Popen(
        [PY, "-u", "tests/fake_dav.py", str(DAV_PORT), "good"], cwd=ROOT,
        stdout=dav_log, stderr=subprocess.STDOUT))
    PROCS.append(subprocess.Popen(
        [PY, "-u", "main.py", "--port", str(PORT)], cwd=ROOT, env=env,
        stdout=main_log, stderr=subprocess.STDOUT))

    if not wait_port(PORT):
        print("主服务启动失败")
        dump_tail(os.path.join(TEST_DATA_DIR, "main.log"))
        dump_tail(os.path.join(TEST_DATA_DIR, "fake-dav.log"))
        cleanup()
        return 2
    print(f"  主服务就绪 http://127.0.0.1:{PORT}（隔离实例，用户服务 8771 不受影响）")

    # 只起环境不跑测试：手动调试单个浏览器测试时用
    if "--env-only" in sys.argv:
        print("保持运行中，Ctrl+C 退出并清理…")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            cleanup()
        return 0

    results = []
    results.append(("仓库级约束（语法/零依赖/CI 配置）", run(
        "Python 3.9 语法兼容 / 注解延迟求值 / 运行时零依赖 / CI 配置不漂移",
        [PY, "tests/test_compat.py"])))
    results.append(("端到端（正常服务器）", run(
        "端到端：扫描 → 索引 → Range 流 → 进度收藏",
        [PY, "tests/test_e2e.py"])))
    results.append(("忽略 Range 的服务器", run(
        "服务器忽略 Range 时的本地字节裁剪",
        [PY, "tests/test_norange.py"])))
    results.append(("子目录错误降级", run(
        "子目录列举失败时降级而非整轮崩溃（v1.0.0 回归）",
        [PY, "tests/test_subdir_error.py"])))
    results.append(("字幕关联", run(
        "同目录同名字幕关联到视频 / 字幕流读取 / .ass 忽略",
        [PY, "tests/test_subtitles.py"])))
    results.append(("播放队列", run(
        "目录自然序（第2集<第10集）/ 队列持久化 / 失效id剔除 / 非法payload",
        [PY, "tests/test_queue.py"])))
    results.append(("增量扫描与断点续扫", run(
        "未变项跳过（indexed_at 不刷新）/ mtime+size 签名 / 断点续扫 / 取消保留进度",
        [PY, "tests/test_incremental.py"])))
    results.append(("失败目录重扫 + 差异报告", run(
        "失败目录持久化可观测 / mode=failed 只重扫失败目录 / 差异报告记录消失路径",
        [PY, "tests/test_failed_dirs.py"])))
    results.append(("局域网访问密码 / 令牌", run(
        "门禁拦截 API 与媒体流 / Cookie·Bearer·token 三种凭据 / 限流 / 非本机绑定强制设密码",
        [PY, "tests/test_access.py"])))
    results.append(("配置导入导出 / 备份", run(
        "导出脱敏与含密码 / 跨实例按稳定键恢复收藏与进度 / 幂等与合并语义 / 非法备份 400",
        [PY, "tests/test_backup.py"])))
    results.append(("一键演示", run(
        "demo.py 零配置起假 WebDAV / 真可解码可拖动 / 数据隔离与护栏 / 重启幂等",
        [PY, "tests/test_demo.py"])))
    results.append(("发布资产", run(
        "可复现 zip 与 SHA256 / 不含本机产物 / 解压可 import / CHANGELOG 发布说明 / Release 流程",
        [PY, "tests/test_release.py"])))

    # 认证场景需要把假服务器切到 auth 模式
    print("\n  切换假服务器到认证模式…")
    PROCS[0].terminate()
    try:
        PROCS[0].wait(timeout=5)
    except Exception:
        pass
    kill_port(DAV_PORT)          # 确保端口真的释放（防残留/双绑定）
    time.sleep(0.3)
    PROCS[0] = subprocess.Popen(
        [PY, "-u", "tests/fake_dav.py", str(DAV_PORT), "auth"], cwd=ROOT,
        stdout=_open_log("fake-dav-auth.log"), stderr=subprocess.STDOUT)
    time.sleep(1.0)
    results.append(("认证与错误场景", run(
        "Basic 认证 / 远端文件消失 / 密码不外泄",
        [PY, "tests/test_edge.py"])))

    cleanup()
    print(f"\n{'=' * 62}")
    print("测试汇总")
    print("=" * 62)
    for name, ok in results:
        print(f"  {'✓ 通过' if ok else '✗ 失败'}  {name}")
    all_ok = all(ok for _, ok in results)
    print(f"\n{'全部通过' if all_ok else '存在失败项'}")
    return 0 if all_ok else 1


def cleanup() -> None:
    for p in PROCS:
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        cleanup()
        sys.exit(130)
    except Exception:
        # 脚手架自己出 bug 时也要留下痕迹：CI 上只给一个 exit code 是排不了障的
        import traceback

        traceback.print_exc()
        cleanup()
        sys.exit(1)
