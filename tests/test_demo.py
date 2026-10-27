#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：一键演示 demo.py（v1.9.0）。

覆盖：
  1. --help / --reset 护栏可用（--reset 拒绝作用在非默认目录）
  2. 一条命令起得来：假 WebDAV + 主服务 + 两个演示源 + 自动扫描完成
  3. 演示内容是真的：视频有封面、有同名字幕、媒体流 Range 返回 206、
     内容前几个字节是 WebM 魔数（不是随机占位垃圾）
  4. 预置的收藏与观看进度真的写进去了（界面一打开就有内容）
  5. 数据隔离：演示实例只认 --data 目录，绝不碰真实 data/；
     --data 指向 data/ 时直接拒绝启动
  6. 幂等：同目录重启不会重复建源、不会重复堆媒体
  7. Server 响应头里的版本号与 backend.__version__ 一致（不再是写死的 1.0）

自包含：全部通过子进程跑 demo.py，用完杀掉并清理临时目录。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
PORT = 8959
DAV_PORT = 8895
BASE = f"http://127.0.0.1:{PORT}"
DATA = tempfile.mkdtemp(prefix="websua-demo-test-")
PASS = FAIL = 0
PROC = None


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


def req(path, method="GET", headers=None, timeout=10):
    """返回 (状态码, 响应头 dict, 原始 bytes)。"""
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    r = urllib.request.Request(BASE + path, method=method, headers=headers or {})
    try:
        with op.open(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


def jget(path, **kw):
    st, _, body = req(path, **kw)
    try:
        return st, json.loads(body.decode("utf-8"))
    except Exception:
        return st, {}


def env_without_data():
    env = {**os.environ}
    env.pop("WEBSUA_DATA", None)     # 让 demo.py 自己决定数据目录
    env.pop("WEBSUA_SCAN_RATE", None)
    return env


def run_demo(extra=None, wait=True, timeout=40):
    """启动 demo.py 子进程。返回 Popen（wait=True 时等到 /api/health 就绪）。"""
    args = [PY, "demo.py", "--no-browser", "--port", str(PORT),
            "--dav-port", str(DAV_PORT), "--data", DATA] + (extra or [])
    p = subprocess.Popen(args, cwd=ROOT, env=env_without_data(),
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if not wait:
        return p
    deadline = time.time() + timeout
    while time.time() < deadline:
        if p.poll() is not None:
            out = p.stdout.read().decode("utf-8", "replace") if p.stdout else ""
            print("  demo 进程提前退出：\n" + out[-2000:])
            return p
        try:
            st, _ = jget("/api/health", timeout=2)
            if st == 200:
                return p
        except Exception:
            pass
        time.sleep(0.3)
    return p


def stop(p):
    if not p:
        return
    try:
        p.terminate()
        p.wait(timeout=8)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


def main():
    global PROC
    print("=" * 62)
    print("场景：一键演示 demo.py（假 WebDAV + 隔离数据目录）")
    print("=" * 62)

    # ---- 1. 命令行护栏 ----
    r = subprocess.run([PY, "demo.py", "--help"], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=60)
    check("--help 正常退出", r.returncode == 0, f"rc={r.returncode}")
    check("--help 提到 --reset 与 --no-browser",
          "--reset" in r.stdout and "--no-browser" in r.stdout)

    # --data 指向真实 data/ → 必须拒绝（防止演示把用户库当成玩具）
    check("拒绝把真实 data/ 当演示目录",
          subprocess.run([PY, "demo.py", "--data", "data", "--reset"], cwd=ROOT,
                         capture_output=True, timeout=60).returncode != 0)

    # --reset 只对默认演示目录生效，自定义目录必须拒绝且不删文件
    sentinel = os.path.join(DATA, "别动我.txt")
    with open(sentinel, "w", encoding="utf-8") as f:
        f.write("keep")
    r = subprocess.run([PY, "demo.py", "--data", DATA, "--reset"], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=60)
    check("--reset 拒绝作用在自定义目录", r.returncode != 0, f"rc={r.returncode}")
    check("--reset 被拒后没有删掉任何文件", os.path.isfile(sentinel))
    os.remove(sentinel)

    # ---- 2. 起演示实例 ----
    PROC = run_demo()
    check("演示实例启动并就绪", PROC.poll() is None)
    if PROC.poll() is not None:
        return finish()

    st, sources = jget("/api/sources")
    srcs = sources.get("sources") or []
    check("自动建了 2 个演示源", len(srcs) == 2,
          f"实际 {len(srcs)}: {[s['name'] for s in srcs]}")
    names = {s["name"] for s in srcs}
    check("源名称符合预期", names == {"演示库", "短片收藏"}, str(names))
    check("演示源都指向本机假 WebDAV",
          all(f"127.0.0.1:{DAV_PORT}/dav" in s["base_url"] for s in srcs),
          str([s["base_url"] for s in srcs]))
    check("扫描已完成（item_count > 0）",
          all((s.get("item_count") or 0) > 0 for s in srcs),
          str([s.get("item_count") for s in srcs]))

    st, media = jget("/api/media?limit=100")
    items = media.get("media") or []
    vids = [m for m in items if m["kind"] == "video"]
    imgs = [m for m in items if m["kind"] == "image"]
    # 两个源有重叠（短片目录被单独又建了一个源），所以总数是 8+1 视频
    # 与 1 张独立照片；被当成封面的 .jpg 已被剔除，不再单独出现。
    check("扫到 9 个视频（演示库 8 + 短片源 1）", len(vids) == 9, f"实际 {len(vids)}")
    check("只剩 1 张独立照片（其余 .jpg 都成了封面）", len(imgs) == 1,
          f"实际 {len(imgs)}: {[m['name'] for m in imgs]}")
    check("非媒体文件（.txt）没被索引",
          not any(m["name"].endswith(".txt") for m in items))
    check("封面图不再作为独立图片重复出现",
          not any(m["name"] in ("星际漫游.jpg", "深蓝回声.jpg") for m in items))

    # ---- 3. 演示内容是真的 ----
    by_name = {m["name"]: m for m in items}
    main_v = by_name.get("星际漫游.webm")
    check("主片被索引", main_v is not None)
    if main_v:
        check("主片关联到同名字幕", bool(main_v.get("subtitle")),
              str(main_v.get("subtitle")))
        check("主片关联到同名封面", bool(main_v.get("poster")),
              str(main_v.get("poster")))
        st, _, sub = req(main_v["subtitle"])
        check("字幕接口返回 200", st == 200, f"st={st}")
        check("字幕内容确实是演示字幕",
              "演示字幕" in sub.decode("utf-8", "replace"))

        # Range：拖进度条的关键
        st, hdrs, chunk = req(main_v["stream"], headers={"Range": "bytes=1000-1999"})
        check("媒体流支持 Range（206）", st == 206, f"st={st}")
        check("Content-Range 正确",
              hdrs.get("Content-Range", "").startswith("bytes 1000-1999/"),
              str(hdrs.get("Content-Range")))
        check("返回的正是请求的那 1000 字节", len(chunk) == 1000, f"{len(chunk)}B")

        # 内容是 WebM 容器（EBML 魔数 1A 45 DF A3），不是随机字节
        st, _, head = req(main_v["stream"], headers={"Range": "bytes=0-3"})
        check("视频是真实可解码的 WebM", head == b"\x1a\x45\xdf\xa3", head.hex())

    # ---- 4. 预置的收藏 / 进度 ----
    fav = [m for m in items if m.get("is_fav")]
    check("预置了 1 条收藏", len(fav) == 1, str([m["name"] for m in fav]))
    check("收藏的就是主片", bool(fav) and fav[0]["name"] == "星际漫游.webm")
    ep3 = by_name.get("第03集.webm")
    check("剧集第 3 集有观看进度", ep3 is not None and (ep3.get("position") or 0) > 0,
          str(ep3.get("position") if ep3 else None))
    done = by_name.get("深蓝回声.webm")
    check("深蓝回声标记为已看完", done is not None and bool(done.get("finished")))

    # ---- 5. 版本号一致性（顺带修的写死 1.0）----
    st, hdrs, _ = req("/api/health")
    sys.path.insert(0, ROOT)
    sys.path.insert(0, os.path.join(ROOT, "tests"))
    import backend                                # noqa: E402
    srv_ver = hdrs.get("Server", "")
    # BaseHTTPRequestHandler 会在 server_version 后面自动补 " Python/x.y.z"
    check("Server 响应头版本号与 __version__ 一致",
          srv_ver.startswith(f"WebSua/{backend.__version__}"),
          f"{srv_ver} vs WebSua/{backend.__version__}")

    # ---- 6. 重启幂等 ----
    stop(PROC)
    PROC = None
    PROC = run_demo()
    if PROC.poll() is None:
        st, sources2 = jget("/api/sources")
        check("重启后仍是 2 个源（不重复建源）",
              len(sources2.get("sources") or []) == 2,
              str([s["name"] for s in sources2.get("sources") or []]))
        st, media2 = jget("/api/media?limit=100")
        check("重启后媒体数不翻倍（扫描幂等）",
              len(media2.get("media") or []) == len(items),
              f"{len(media2.get('media') or [])} vs {len(items)}")
    else:
        check("重启后仍能启动", False)
        check("重启后媒体数不翻倍（扫描幂等）", False)

    return finish()


def finish():
    global PROC
    stop(PROC)
    PROC = None
    shutil.rmtree(DATA, ignore_errors=True)
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        stop(PROC)
        sys.exit(130)
