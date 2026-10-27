"""控制台编码兜底 —— 所有会打印中文的脚本都 import 它。

英文区域的 Windows 控制台默认是 cp1252，`print("字幕关联")` 会抛
UnicodeEncodeError 直接把脚本打挂（CI 上就是这么红的，而且一次红一整套）。

规则：
  · 输出不是终端（CI 的 tee / 重定向到文件）→ 用 UTF-8，日志里的中文才可读；
  · 输出是终端 → 保持控制台原生编码，只把编码错误降级成替换字符，
    免得在 cmd 里变成一堆乱码。

import 即生效，没有函数调用负担。
"""
from __future__ import annotations

import sys


def setup() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            if not stream.isatty():
                stream.reconfigure(encoding="utf-8", errors="replace")
            else:
                stream.reconfigure(errors="replace")
        except Exception:
            # 老版本 / 被替换过的流（如 pytest 捕获）不支持 reconfigure，忽略
            pass


setup()
