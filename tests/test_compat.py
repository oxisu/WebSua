#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景：仓库级约束检查（不启动服务，纯静态）。

这类检查守的是「会悄悄漂移」的东西 —— 不是功能，而是承诺：

  1. **Python 3.9 兼容**：main.py 里写着「需要 3.9+」，那就得真能跑。
     用 ast 的 feature_version 按 3.9 语法解析全部源码（CI 矩阵里有 3.9）。
  2. **将来注解必须延迟求值**：用了 `X | Y` 注解又没有
     `from __future__ import annotations` 的文件，在 3.9 上 import 就炸。
  3. **零依赖**：backend/、main.py、demo.py 只允许 import 标准库与本地模块。
     这是 README 的第一条卖点，最容易被「顺手 pip install 一下」破坏。
  4. **CI 配置不漂移**：workflow 里引用的测试脚本必须真实存在，
     矩阵最低版本必须与 main.py 的版本门槛一致。
  5. **开发依赖不外溢**：package.json 只允许有 Playwright 这类测试用 devDependencies。

只依赖标准库，能单独跑，也能挂在 run_all 后面。
"""
import ast
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "ci.yml")
PASS = FAIL = 0

# 允许 import 的本地模块（backend 包、demo 复用的测试用假服务器）
LOCAL_MODULES = {"backend", "fake_dav", "tests"}

# CI 矩阵最低版本要与 main.py 的门槛一致
TARGET = (3, 9)


def check(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}" + (f"  {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {label}  {detail}")


def py_files():
    out = []
    for base in ("backend", "tests"):
        d = os.path.join(ROOT, base)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".py"):
                out.append(os.path.join(d, fn))
    for fn in ("main.py", "demo.py"):
        p = os.path.join(ROOT, fn)
        if os.path.isfile(p):
            out.append(p)
    return out


def parse(path):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    return src, ast.parse(src, filename=path)


def has_future_annotations(src):
    return "from __future__ import annotations" in src


def annotations(tree):
    """产出模块里所有注解表达式节点。"""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = node.args
            for arg in (list(a.args) + list(a.posonlyargs) + list(a.kwonlyargs)
                        + [a.vararg, a.kwarg]):
                if arg is not None and arg.annotation is not None:
                    yield arg.annotation
            if node.returns is not None:
                yield node.returns
        elif isinstance(node, ast.AnnAssign) and node.annotation is not None:
            yield node.annotation


def uses_pep604(expr):
    return any(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr)
               for n in ast.walk(expr))


def top_imports(tree):
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                mods.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                mods.add(node.module.split(".")[0])
    return mods


def main():
    print("=" * 62)
    print("场景：仓库级约束检查（语法兼容 / 零依赖 / CI 配置漂移）")
    print("=" * 62)

    files = py_files()
    check("找到源码文件", len(files) >= 10, f"{len(files)} 个")

    # ---- 1. Python 3.9 语法兼容 ----
    bad = []
    for p in files:
        try:
            with open(p, "r", encoding="utf-8") as f:
                ast.parse(f.read(), filename=p, feature_version=TARGET)
        except SyntaxError as e:
            bad.append(f"{os.path.relpath(p, ROOT)}:{e.lineno} {e.msg}")
    check(f"全部源码符合 Python {TARGET[0]}.{TARGET[1]} 语法",
          not bad, "; ".join(bad[:3]))

    # ---- 2. 将来注解 ----
    offenders = []
    for p in files:
        src, tree = parse(p)
        if has_future_annotations(src):
            continue
        if any(uses_pep604(a) for a in annotations(tree)):
            offenders.append(os.path.relpath(p, ROOT))
    check("用 `X | Y` 注解的文件都有 future 导入（否则 3.9 import 即炸）",
          not offenders, ", ".join(offenders[:3]))

    # ---- 3. 零依赖 ----
    stdlib = getattr(sys, "stdlib_module_names", None)
    if stdlib is None:
        print("  [SKIP] 当前解释器没有 stdlib_module_names，跳过零依赖扫描")
    else:
        third = []
        for p in files:
            rel = os.path.relpath(p, ROOT)
            # 只审运行时（backend / 入口脚本），测试文件可以用测试专用库
            if not (rel.startswith("backend" + os.sep) or rel in ("main.py", "demo.py")):
                continue
            _, tree = parse(p)
            for m in sorted(top_imports(tree)):
                if m in LOCAL_MODULES or m in stdlib:
                    continue
                third.append(f"{rel}: {m}")
        check("运行时只依赖标准库（零依赖卖点）", not third, "; ".join(third[:5]))

        # 明确禁止的东西：写过 requirements.txt 就说明有人打算破坏零依赖
        check("仓库里没有 requirements.txt",
              not os.path.isfile(os.path.join(ROOT, "requirements.txt")))

    # ---- 4. CI 配置 ----
    check("存在 GitHub Actions workflow", os.path.isfile(WORKFLOW))
    if os.path.isfile(WORKFLOW):
        with open(WORKFLOW, "r", encoding="utf-8") as f:
            wf = f.read()

        # 最低 Python 版本 vs main.py 门槛
        with open(os.path.join(ROOT, "main.py"), "r", encoding="utf-8") as f:
            main_src = f.read()
        m = re.search(r"sys\.version_info\s*<\s*\((\d+),\s*(\d+)\)", main_src)
        check("main.py 有明确的最低版本门槛", m is not None)
        if m:
            low = (int(m.group(1)), int(m.group(2)))
            check("最低版本门槛与本次检查目标一致", low == TARGET, f"{low} vs {TARGET}")
            versions = re.findall(r'"(3\.\d+)"', wf)
            check("CI 矩阵覆盖最低版本",
                  any(v == f"{low[0]}.{low[1]}" for v in versions),
                  f"矩阵: {sorted(set(versions))}")

        check("CI 跑全量回归 run_all.py", "tests/run_all.py" in wf)
        check("CI 三平台矩阵", all(k in wf for k in ("ubuntu-latest", "windows-latest",
                                                    "macos-latest")))

        # workflow 里引用的脚本必须真实存在（防止改了文件名忘了改 CI）
        missing = []
        for rel in set(re.findall(r"tests/[\w]+\.(?:py|js)", wf)):
            if not os.path.isfile(os.path.join(ROOT, *rel.split("/"))):
                missing.append(rel)
        check("CI 引用的测试脚本都存在", not missing, ", ".join(missing))

        # 浏览器 job 必须装 chromium（否则 UI 套件必然启动失败）
        check("浏览器 job 安装了 Chromium", "playwright install" in wf and "chromium" in wf)

    # ---- 5. 开发依赖 ----
    pkg = os.path.join(ROOT, "package.json")
    check("存在 package.json（只在开发期用）", os.path.isfile(pkg))
    if os.path.isfile(pkg):
        with open(pkg, "r", encoding="utf-8") as f:
            data = json.load(f)
        check("package.json 标记为 private（不会被误发布）", data.get("private") is True)
        check("没有运行时 dependencies 字段",
              not data.get("dependencies"), str(data.get("dependencies")))
        dev = data.get("devDependencies") or {}
        check("devDependencies 含 playwright",
              any(k.startswith("playwright") for k in dev), str(list(dev)))

    # ---- 6. 浏览器可执行文件探测跨平台 ----
    be = os.path.join(ROOT, "tests", "browser-env.js")
    check("存在 tests/browser-env.js", os.path.isfile(be))
    if os.path.isfile(be):
        with open(be, "r", encoding="utf-8") as f:
            js = f.read()
        for hint, label in (("chrome-linux", "Linux"),
                            ("chrome-mac", "macOS"),
                            ("chrome-win64", "Windows"),
                            ("PLAYWRIGHT_CHROME", "环境变量覆盖")):
            check(f"浏览器探测支持 {label}", hint in js)

    print(f"\n结果：通过 {PASS} 项，失败 {FAIL} 项")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
