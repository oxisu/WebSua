"""全局配置与路径管理。"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("WEBSUA_DATA", BASE_DIR / "data"))
FRONTEND_DIR = BASE_DIR / "frontend"
DB_PATH = DATA_DIR / "library.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# 视频/图片扩展名
VIDEO_EXTS = {
    ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".mts", ".rmvb", ".3gp", ".vob", ".ogv",
}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".wma", ".ape"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".heic", ".jxl"}
SUBTITLE_EXTS = {".srt", ".ass", ".ssa", ".vtt", "sub"}

KIND_BY_EXT = {}
for _e in VIDEO_EXTS:
    KIND_BY_EXT[_e] = "video"
for _e in AUDIO_EXTS:
    KIND_BY_EXT[_e] = "audio"
for _e in IMAGE_EXTS:
    KIND_BY_EXT[_e] = "image"

MIME_BY_EXT = {
    ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
    ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".flv": "video/x-flv",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".flac": "audio/flac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/opus",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
    ".srt": "application/x-subrip", ".ass": "text/x-ssa", ".vtt": "text/vtt",
}

# 扫描时忽略的目录名（大小写不敏感）
SKIP_DIRS = {
    "@eaDir", ".git", ".svn", ".thumbnails", "thumbs", "#recycle",
    "#snapshot", ".trash", "$recycle.bin", "system volume information",
    ".ds_store", "__pycache__", ".cache", "node_modules", ".workbuddy",
}

SCAN_MAX_DEPTH = int(os.environ.get("WEBSUA_SCAN_DEPTH", "8"))
SCAN_CONCURRENCY = int(os.environ.get("WEBSUA_SCAN_CONCURRENCY", "4"))
STREAM_CHUNK = 1024 * 512

# ---- 扫描限流 / 重试（云端文件过多时避免触发限流被 ban）----
# 每次 PROPFIND 之间的最小间隔（秒）。文件极多的网盘会频繁请求，
# 间隔太小容易被服务器限流（HTTP 429）甚至临时封禁。
SCAN_RATE_LIMIT = float(os.environ.get("WEBSUA_SCAN_RATE", "0.25"))
# 限流/服务器错误时的重试次数与退避基数（秒）。指数退避：0.5s, 1s, 2s…
SCAN_RETRIES = int(os.environ.get("WEBSUA_SCAN_RETRIES", "3"))
SCAN_RETRY_BACKOFF = float(os.environ.get("WEBSUA_SCAN_BACKOFF", "1.0"))
# 429（限流）额外等待的秒数，会叠加在退避之上
SCAN_429_EXTRA_WAIT = float(os.environ.get("WEBSUA_SCAN_429_WAIT", "5.0"))
# 扫描的 HTTP 超时（秒）。TB 级网盘的大目录（上万文件）PROPFIND 响应很慢，
# 30s 默认值会让大目录整目录超时被跳过，表现为「扫描出的文件数远少于网盘显示」。
SCAN_HTTP_TIMEOUT = int(os.environ.get("WEBSUA_SCAN_HTTP_TIMEOUT", "120"))
# 每遍历多少目录 / 发现多少文件，往任务日志记一条进度（TB 级扫描动辄几十分钟，
# 没有周期日志用户无从判断是在干活还是卡死了）
SCAN_LOG_EVERY_DIRS = int(os.environ.get("WEBSUA_SCAN_LOG_EVERY_DIRS", "25"))
SCAN_LOG_EVERY_FILES = int(os.environ.get("WEBSUA_SCAN_LOG_EVERY_FILES", "500"))

# 扫描日志文件
SCAN_LOG_PATH = DATA_DIR / "scan.log"
SCAN_LOG_MAX_BYTES = 512 * 1024  # 超过则轮转
