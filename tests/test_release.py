#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：发布资产（v1.11.0）。

覆盖：
  1. `scripts/package.py` 能打出 zip，包内顶层目录带版本号
  2. 关键文件齐全（入口、后端、前端、文档、license），
     且 demo 依赖的 tests/fake_dav.py 与样例视频也在 —— 否则「一键试用」失效
  3. 绝不打包本机产物：data/、__pycache__、*.db、*.log、node_modules、.git
  4. 包里所有 .py 都能编译（防止文件被截断/漏拷）
  5. **可复现**：同一份源码连打两次，SHA256 必须一致
  6. `.sha256` 校验文件格式正确、内容与 zip 实际哈希一致
  7. 包内版本号 = 文件名版本号 = backend.__version__
  8. 解压后 `import backend.server` 成功（发布包真的能用，不只是能解压）
  9. `scripts/changelog_section.py` 能抽出当前版本段落；查不到时返回码 2
 10. `.github/workflows/release.yml` 配置不漂移（tag 触发、脚本存在、上传 zip）
 11. `dist/` 已被 gitignore（发布产物不该进版本库）

自包含：不需要起任何服务。
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

PASS = FAIL = 0
PY = sys.executable


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


def version():
    with open(os.path.join(ROOT, "backend", "__init__.py"), "r", encoding="utf-8") as f:
        return re.search(r'__version__\s*=\s*"([^"]+)"', f.read()).group(1)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    print("=" * 62)
    print("场景：发布资产（可复现 zip / 校验和 / CHANGELOG 说明 / Release 流程）")
    print("=" * 62)
    ver = version()
    out = tempfile.mkdtemp(prefix="websua-release-test-")

    try:
        # ---- 1. 打包 ----
        r = subprocess.run([PY, "scripts/package.py", "--out", out], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=180)
        check("package.py 正常退出", r.returncode == 0, (r.stderr or "")[-200:])
        zip_path = os.path.join(out, f"WebSua-{ver}.zip")
        check("产出 zip 文件名带版本号", os.path.isfile(zip_path), zip_path)

        if not os.path.isfile(zip_path):
            return finish(out)

        names = zipfile.ZipFile(zip_path).namelist()
        prefix = f"WebSua-{ver}/"
        check("包内只有一个顶层目录且带版本号",
              all(n.startswith(prefix) for n in names), str(names[:2]))

        rel = {n[len(prefix):] for n in names}

        for need in ("main.py", "demo.py", "README.md", "CHANGELOG.md", "LICENSE",
                     "backend/__init__.py", "backend/server.py", "backend/db.py",
                     "frontend/index.html", "frontend/js/app.js", "frontend/css/app.css",
                     "docs/ROADMAP.md", "tests/fake_dav.py", "tests/run_all.py"):
            check(f"包含 {need}", need in rel)

        # demo 要用真实样例视频，否则演示是黑屏
        webm = [p for p in rel if p.startswith("tests/fixtures/") and p.endswith(".webm")]
        check("包含演示用样例视频", len(webm) >= 1, f"{len(webm)} 个")

        # ---- 3. 不含本机产物 ----
        bad = [p for p in rel
               if p.startswith("data/") or p.startswith("data-test/") or p.startswith("data-demo/")
               or "__pycache__" in p or p.startswith("node_modules/")
               or p.startswith(".git/") or p.startswith("dist/")
               or p.endswith((".pyc", ".db", ".db-wal", ".db-shm", ".log"))]
        check("不含 data/ 缓存与编译产物", not bad, ", ".join(bad[:3]))

        # ---- 4. 所有 .py 能编译 ----
        broken = []
        with zipfile.ZipFile(zip_path) as z:
            for n in rel:
                if not n.endswith(".py"):
                    continue
                try:
                    compile(z.read(prefix + n), n, "exec")
                except SyntaxError as e:
                    broken.append(f"{n}:{e.lineno}")
        check("包内所有 .py 可编译（没被截断）", not broken, ", ".join(broken[:3]))

        # ---- 5. 可复现 ----
        out2 = tempfile.mkdtemp(prefix="websua-release-test2-")
        subprocess.run([PY, "scripts/package.py", "--out", out2], cwd=ROOT,
                       capture_output=True, timeout=180)
        h1, h2 = sha256(zip_path), sha256(os.path.join(out2, f"WebSua-{ver}.zip"))
        check("两次打包 SHA256 一致（可复现）", h1 == h2, f"{h1[:12]} vs {h2[:12]}")
        shutil.rmtree(out2, ignore_errors=True)

        # ---- 6. 校验文件 ----
        sha_file = zip_path + ".sha256"
        check("生成了 .sha256 校验文件", os.path.isfile(sha_file))
        if os.path.isfile(sha_file):
            with open(sha_file, "r", encoding="utf-8") as f:
                line = f.read().strip()
            parts = line.split("  ")
            check("校验文件是 sha256sum 格式（哈希 + 两空格 + 文件名）",
                  len(parts) == 2 and parts[1] == os.path.basename(zip_path), line[:60])
            check("校验文件里的哈希与 zip 实际哈希一致", parts[0] == h1)

        # ---- 7. 版本号一致 ----
        with zipfile.ZipFile(zip_path) as z:
            inner = z.read(prefix + "backend/__init__.py").decode("utf-8")
        inner_ver = re.search(r'__version__\s*=\s*"([^"]+)"', inner).group(1)
        check("包内版本号与 __version__ 一致", inner_ver == ver, f"{inner_ver} vs {ver}")

        # ---- 8. 解压后真能 import ----
        ex = tempfile.mkdtemp(prefix="websua-release-extract-")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(ex)
        code = ("import sys; sys.path.insert(0, '.');"
                "import backend.server, backend.scanner, backend.backup, backend.auth;"
                "print('IMPORT-OK')")
        r = subprocess.run([PY, "-c", code], cwd=os.path.join(ex, f"WebSua-{ver}"),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        check("解压后能 import 后端模块（发布包可用）",
              "IMPORT-OK" in (r.stdout or ""), (r.stderr or "")[-200:])
        shutil.rmtree(ex, ignore_errors=True)

        # ---- 9. CHANGELOG ----
        with open(os.path.join(ROOT, "CHANGELOG.md"), "r", encoding="utf-8") as f:
            cl = f.read()
        check(f"CHANGELOG 有 {ver} 段落", f"[{ver}]" in cl)
        r = subprocess.run([PY, "scripts/changelog_section.py", f"v{ver}"], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        check("能抽出该版本的发布说明", r.returncode == 0, (r.stderr or "")[-120:])
        check("发布说明里有实际内容（至少一条变更）",
              r.returncode == 0 and "- " in r.stdout and ver in r.stdout)
        check("版本号带不带 v 都能抽",
              subprocess.run([PY, "scripts/changelog_section.py", ver], cwd=ROOT,
                             capture_output=True, timeout=60).returncode == 0)

        r = subprocess.run([PY, "scripts/changelog_section.py", "v0.0.0-nope"], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        check("版本不存在时返回码 2（不静默发空说明）", r.returncode == 2, f"rc={r.returncode}")

        # ---- 10. 发布流程配置 ----
        wf_path = os.path.join(ROOT, ".github", "workflows", "release.yml")
        check("存在 release workflow", os.path.isfile(wf_path))
        if os.path.isfile(wf_path):
            with open(wf_path, "r", encoding="utf-8") as f:
                wf = f.read()
            check("由 v* tag 触发", '"v*"' in wf or "'v*'" in wf)
            check("发布前跑回归", "tests/run_all.py" in wf)
            check("调用了打包脚本", "scripts/package.py" in wf)
            check("调用了 CHANGELOG 抽取脚本", "scripts/changelog_section.py" in wf)
            check("上传 zip 与校验和", "*.zip" in wf and ".sha256" in wf)

        # ---- 11. 发布产物不入库 ----
        with open(os.path.join(ROOT, ".gitignore"), "r", encoding="utf-8") as f:
            gi = f.read()
        check("dist/ 已被 gitignore", "dist/" in gi.splitlines())

    finally:
        shutil.rmtree(out, ignore_errors=True)

    return finish(None)


def finish(_):
    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
