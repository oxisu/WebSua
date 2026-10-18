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
# 只把 .srt / .vtt 当作可内挂字幕：.ass/.ssa 的样式与定位解析复杂度高，
# 明确不支持（前端会提示）。二者仅作为提示，不建立索引。
SUBTITLE_KIND_EXTS = {".srt", ".vtt"}

KIND_BY_EXT = {}
for _e in VIDEO_EXTS:
    KIND_BY_EXT[_e] = "video"
for _e in AUDIO_EXTS:
    KIND_BY_EXT[_e] = "audio"
for _e in IMAGE_EXTS:
    KIND_BY_EXT[_e] = "image"
for _e in SUBTITLE_KIND_EXTS:
    KIND_BY_EXT[_e] = "subtitle"

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

# ---- 增量扫描 / 断点续扫 ----
# 扫描中途发现的文件先写 scan_stage 暂存表（而不是全堆内存），每这么多条批量落库一次
SCAN_STAGE_FLUSH_EVERY = int(os.environ.get("WEBSUA_SCAN_STAGE_FLUSH", "500"))
# 断点（待遍历目录栈）持久化节流：每这么多目录、或这么多秒才存一次。
# 全量栈 JSON 可能上百 KB，每个目录都存会把 DB 写爆；取消/完成时总会再存一次，
# 所以这里丢的也只是「最近一会儿」的进度，重扫那几个目录而已。
SCAN_STATE_SAVE_EVERY_DIRS = int(os.environ.get("WEBSUA_SCAN_STATE_DIRS", "100"))
SCAN_STATE_SAVE_EVERY_SECS = float(os.environ.get("WEBSUA_SCAN_STATE_SECS", "30"))

# 扫描日志文件
SCAN_LOG_PATH = DATA_DIR / "scan.log"
SCAN_LOG_MAX_BYTES = 512 * 1024  # 超过则轮转

# ---- 访问门禁（局域网密码 / 令牌）----
# 登录签发的 token 有效期（秒）。默认 30 天：家用场景不该天天重新登录，
# 但也不能做成永不过期（丢了设备没法吊销）。
ACCESS_TOKEN_TTL = int(os.environ.get("WEBSUA_TOKEN_TTL", str(30 * 24 * 3600)))
# 密码哈希的 pbkdf2 迭代次数（越高越抗暴力，代价是登录时多几十毫秒）
ACCESS_PBKDF2_ITERS = int(os.environ.get("WEBSUA_PBKDF2_ITERS", "200000"))
# 登录失败限流：同一来源连续失败这么多次后，锁定这么多秒
ACCESS_MAX_FAILS = int(os.environ.get("WEBSUA_ACCESS_MAX_FAILS", "5"))
ACCESS_FAIL_LOCKOUT = int(os.environ.get("WEBSUA_ACCESS_LOCKOUT", "60"))
