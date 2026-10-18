# WebSua - 云刷

> **WebSua** ("云刷") — Turn videos scattered across multiple WebDAV drives into
> one endless, swipeable stream.
> 多 WebDAV 视频流播放器：把分散在多个网盘里的视频，变成一条可以像刷短视频一样连续播放的视频流。

- **零依赖**：前端原生 ES Module + CSS，后端 Python **纯标准库**，`python main.py` 双击即用
- **多源**：每个 WebDAV 独立成一个文件源，各自扫描、各自筛选
- **三端自适应**：手机（底部标签栏）/ 平板（图标侧栏）/ 桌面（三栏 + 队列）
- **明暗主题**：跟随系统，可手动切换，无闪白
- **TG 封面**：自动识别 Telegram 导出视频旁的同名封面图（可开关）
- **扫描可控**：限流、指数退避重试、暂停 / 继续 / 停止、日志可查

> 📌 **当前版本只支持 WebDAV 一种扫描协议。** 关于「TB 级网盘改用官方 API 扫描」的
> 方案设想、风险清单与落地步骤，见下方的「十二、下一步方向」——那是设计文档，不是已实现功能。

---

## 快速开始

```bash
python main.py
```

就这一步。首次运行自动创建 `data/library.db` 并打开浏览器。**无需 pip install**。

```bash
python main.py --port 9000        # 指定端口（被占用自动顺延）
python main.py --host 0.0.0.0     # 允许局域网访问
python main.py --browser          # 启动并自动打开浏览器（默认不开）
python main.py --scan             # 启动后立即扫描所有数据源
```

### 常见 WebDAV 地址

| 网盘 | WebDAV 地址 |
| --- | --- |
| Nextcloud | `https://域名/remote.php/dav/files/用户名` |
| ownCloud | `https://域名/remote.php/webdav` |
| 群晖 DSM | `https://域名:5001/webdav` |
| 坚果云 | `https://dav.jianguoyun.com/dav/` |
| alist | `http://域名:5244/dav` |

---

## 功能总览

### 三个视图

| 视图 | 用途 |
| --- | --- |
| 视频流 | 竖屏全屏播放，滚轮/滑动翻页，键盘 ↑↓ 或 k/p |
| 媒体库 | 网格浏览（全部/历史/收藏 三筛选），封面（TG 封面优先，其次视频截帧），搜索/分页 |
| 数据源 | 管理 WebDAV：添加/编辑/启停/删除，扫描进度可控，日志可查，每个源独立 TG 封面开关 |

### 设置（顶栏齿轮）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 自动连播 | 关 | 播放完/出错自动下一条（刷视频模式） |
| 恢复上次播放 | 开 | 打开时恢复上次的播放源、顺序与当前进度 |
| 自动播放 | 开 | 滚动到某条自动播放 |
| 播放器调试日志 | 关 | 在播放器「更多」菜单里开关 |
| 视频流每页条数 | 24 | 决定视频流与「接下来」队列每页加载条数 |
| 媒体库每页条数 | 48 | 媒体库网格滚动到底每次加载条数 |

### 历史播放

- 媒体库顶部「历史」筛选：按最近观看时间倒序展示看过的视频，带进度条与「已看完/百分比」标记
- 点击任意历史项 → 跳回视频流并从上次进度**续播**
- 「恢复上次播放」（默认开）：关闭/重开应用时自动恢复上次的源筛选、顺序，并跳到上次看的那条
- 观看进度每 5 秒上报 + 页面卸载时 `sendBeacon` 兜底，续播同步生效

### TG 导出封面（每个数据源独立开关）

Telegram 桌面版导出视频时，视频旁会带一张附属缩略图。实测命名：

```
1 (3).mp4 + 1 (3).mp4_thumb.jpg   ← TG 主规则（视频全名 + _thumb.jpg）
video.mp4 + video.jpg             ← 同名（其他工具）
video.mp4 + video.mp4.jpg         ← 原名 + .jpg（其他工具）
```

- 数据源编辑弹窗里有「TG 导出封面」开关（`sources.tg_mode`），**每个源独立控制**
- 开启后扫描时自动把同目录匹配的图片关联为视频封面（`/api/poster/{id}`）
- **匹配成功的缩略图从媒体库剔除**——它是视频的附属品，单独显示只是噪音；
  普通图片消息（`photo_xxx.jpg`）不会撞上视频名，不受影响
- 卡片上显示「TG 封面」徽章，媒体库/队列优先用封面，无封面才截帧
- 开关变更后需重新扫描该源生效

### 目录排除

数据源编辑弹窗的「排除目录」输入框（`sources.exclude_dirs`）：

- 逗号分隔**目录名**（中英文逗号均可），如 `抢救（不含文件）,临时`
- 扫描时命中目录名的整个子树被跳过（大小写不敏感）
- 扫描开始日志会记录本次的排除清单，方便核对

### 扫描控制

- 点击「扫描」**先做连通性检测**（probe），密码错/地址错立即报错，不会白扫
- 扫描中可 **暂停 / 继续 / 停止**，停止不落库；点暂停 UI 立即切换（乐观更新，~100ms），不等后端确认
- 进度真实反映已遍历目录数（总数未知，封顶 92%），「当前：/路径」实时显示正在列举哪个目录
- **精细日志**：每 25 个目录 / 每 500 个文件记一条「进度：已遍历 X 目录 · 已发现 Y 文件」，
  再也不是只有一行「开始扫描」的黑箱
- **限流**：每次 PROPFIND 至少间隔 0.25s（可调），避免触发网盘限流
- **重试**：429/5xx/**连接层错误**（TLS 握手超时、连接被拒等）指数退避重试 3 次
  （0.5s→1s→2s，429 额外多等 5s）；视频流打开阶段同样带重试（短超时 15s 快速失败快速重试）
- **大目录保护**：HTTP 超时默认 120s（TB 级网盘的大目录 PROPFIND 响应很慢）；
  目录列举失败**绝不静默**——日志记 error、完成摘要显示「⚠ N 个目录失败被跳过」、
  卡片黄条提示建议重扫
- **日志**：`data/scan.log`（超 512KB 自动轮转），卡片「日志」按钮或「更多 → 查看日志」；
  播放失败也会留痕（源/文件名/远端路径/状态码）

### 播放器

- 桌面横屏视频自适应铺满，竖屏视频自动居中（object-fit: contain）
- 三条看门狗：25s 加载超时 / 20s 播放停滞 / 12s 缓冲未出帧自动重置（最多 3 次）
- 双端点回退：`/api/stream/{id}` 失败自动切 `/api/proxy/{id}`
- 键盘：空格/K 播放暂停，←→ 快退快进 10s，0-9 跳百分比，M 静音，F 全屏，L 循环，R 旋转
- 双击左右侧快退快进，画中画，截图（canvas 导出 PNG），复制直链，速度 0.25x-3x

---

## 目录结构

```
WebSua/
├── main.py                 # 启动入口
├── backend/
│   ├── config.py           # 扩展名/MIME、扫描参数、限流重试参数
│   ├── db.py               # SQLite（单连接 + RLock），含轻量迁移
│   ├── webdav.py           # WebDAV 客户端：PROPFIND（限流+重试）、Range 流读取
│   ├── pan123.py           # 规划中：123 Open API 客户端（token 刷新 + file/list 分页）
│   ├── scanner.py          # 扫描任务：线程 + 暂停/取消 + TG 封面匹配 + 日志
│   ├── stream.py           # HTTP Range 解析与流转发
│   └── server.py           # HTTP 服务：24 个 REST 路由 + 静态资源 + 媒体流
├── frontend/
│   ├── index.html          # 内联主题预执行脚本（防闪白）
│   ├── css/
│   │   ├── theme.css       # 设计令牌：明暗主题、断点、间距、动效
│   │   ├── player.css      # 播放器 cvp-* 类
│   │   └── app.css         # 布局、三断点、组件
│   └── js/
│       ├── app.js          # 入口：路由、侧栏、队列、设置弹窗
│       ├── feed.js         # 竖屏视频流（窗口化挂载 + IntersectionObserver）
│       ├── grid.js         # 媒体网格（分页 + 缩略图）
│       ├── sources.js      # 数据源管理（状态机 + 细粒度 DOM 更新）
│       ├── video-player.js # 播放器（看门狗 + 端点回退 + 更多菜单）
│       ├── thumbs.js       # 视频截帧（并发限 3 + 失败缓存）
│       ├── progress.js     # 观看进度（节流上报 + sendBeacon 兜底）
│       ├── settings.js     # 前端设置（localStorage + 订阅）
│       └── utils.js        # 请求、格式化、Toast、主题
├── tests/
│   ├── fake_dav.py         # 假 WebDAV（good/auth/norange 三模式，含 24 个批量目录）
│   ├── run_all.py          # 一键回归：自动起服务、切模式、清端口、跑完清理
│   ├── test_e2e.py         # 端到端 36 项
│   ├── test_norange.py     # 服务器忽略 Range 时的本地裁剪 17 项
│   ├── test_edge.py        # 认证/远端删除/密码不外泄 14 项
│   ├── test_browser.js     # 浏览器 60 项（三断点 × 明暗 × 布局）
│   ├── test_new_features.js# 新功能 8 项
│   ├── test_ui_polish.js   # UI 打磨 19 项（暂停继续/菜单/折叠/Toast）
│   ├── audit_ui.js         # 全页面截图审查（3 断点 × 12 场景）
│   ├── gen_media.js        # 用 MediaRecorder 生成真 webm 素材
│   └── gen_posters.js      # 生成同名 JPG 封面素材
└── data/
    ├── library.db          # SQLite（自动创建）
    └── scan.log            # 扫描日志
```

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health`、`/api/stats` | 健康检查 / 全局统计 |
| GET/POST | `/api/sources` | 列表（含分类计数、总大小）/ 新增 |
| PUT/DELETE | `/api/sources/{id}` | 修改（密码留空保留）/ 删除（级联清索引） |
| POST | `/api/sources/{id}/probe` | 连通性测试，不落库 |
| POST | `/api/sources/{id}/scan` | 触发扫描（后台线程） |
| POST | `/api/sources/{id}/scan/pause·resume·cancel` | 扫描控制 |
| GET | `/api/tasks`、`/api/tasks/{id}` | 任务列表（每源只留最新）/ 详情含日志 |
| GET | `/api/scan-log` | scan.log 尾部内容 |
| GET | `/api/media` | 分页列表（sources/kinds/folder/q/order/fav/limit/offset） |
| GET | `/api/history` | 观看历史（有进度的媒体，按最近观看时间倒序，支持 sources/limit/offset） |
| GET | `/api/media/{id}` | 详情（播放器信息面板） |
| POST | `/api/media/{id}/fav` | 切换收藏 |
| GET/POST/DELETE | `/api/progress`、`/api/progress-batch` | 观看进度（批量供 sendBeacon） |
| GET | `/api/stream/{id}` | 媒体流（Range，`?dl=1` 下载） |
| GET | `/api/proxy/{id}` | 备用端点（无 Range 全量） |
| GET | `/api/poster/{id}` | TG 同名封面（无则 404） |
| GET/POST | `/api/settings` | 服务端设置（预留） |

---

# 编程经验、坑点与思路

以下是这个项目从零到可用过程中**真实踩过的坑**和对应的思考，按主题整理。

## 一、为什么是「纯标准库」——依赖决策

最初方案是 FastAPI + uvicorn，但构建环境里 pip 镜像不可达（沙箱代理拦截）。两个选择：修网络，或去依赖。

**决策依据**：这是一个「双击 main.py 就能跑」的本地工具，用户群在意的是零安装。FastAPI 的价值（自动文档、类型校验、依赖注入）对 24 个路由的小服务是过度设计。最终手写路由分发只花了 150 行：

```python
class Route:
    def __init__(self, method, pattern, handler):
        self.regex = re.compile("^" + pattern + "$")   # 精确匹配，防前缀误伤
        self.handler = handler

# 注册即路由，装饰器收集
def route(method, pattern):
    def deco(fn):
        AppHandler.routes.append(Route(method, pattern, fn))
        return fn
    return deco
```

**经验**：评估框架价值时，把「这个框架解决的问题在你的规模下是否真实存在」当作唯一标准。路由正则 + dispatch 20 行就能解决的事，不值得为一个依赖引入整个安装链。

## 二、SQLite 并发：单连接 + RLock 比 thread-local 靠谱

`ThreadingHTTPServer` 每请求一线程。SQLite 的两个坑：`check_same_thread`、写锁冲突。

**踩过的方案对比**：
- thread-local 连接：每个 HTTP 线程一个连接 → 线程数不可控（浏览器并发 6+），WAL 模式下读写尚可，但代码里到处 `finally: conn.close()` 很烦
- **单连接 + RLock（最终方案）**：所有 db 函数 `with _lock:` 包住。SQLite 本来就是单写者，应用层串行化反而最简单可靠。读多写少场景性能完全够用（本地服务）

```python
_lock = threading.RLock()
_conn = None

def get_conn():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(...)   # 惰性初始化，首次调用才建
        _conn.execute("PRAGMA journal_mode=WAL")
        ...
    return _conn

def save_progress(...):
    with _lock:                        # RLock 可重入，函数间嵌套调用安全
        get_conn().execute(...)
        get_conn().commit()
```

**坑**：`RLock` 而非 `Lock` —— `bulk_upsert_media` 内部会调用 `get_conn()`，可重入锁避免自锁。

**经验**：本地单机服务，「最大并发」往往被高估。一把大锁 + WAL，比精细的读写锁分离更不容易出死锁。

## 三、HTTP Range 流转发：拖进度条不卡的关键

浏览器 `<video>` seek 靠 Range 请求。处理不好，每次拖进度条都退化成整文件重传。

**实现要点**（`backend/stream.py`）：
1. 三种 Range 语法都要支持：`bytes=a-b`、`bytes=a-`、`bytes=-n`（后缀语义：末尾 N 字节）
2. 越界请求本地判 416，**不要去打扰远端**——各服务器对越界行为不一致
3. `Content-Range`、`Content-Length`、`Accept-Ranges` 三个头一个不能少
4. 响应体用 `iter_chunks` 按 512KB 块转发，并按 Range 裁剪字节数

**最大的坑**：有些 WebDAV 服务器**无视 Range 直接回 200 全量**。此时要本地裁剪：

```python
if range_header and spec and status == 200:
    # 坑：urllib 的 HTTPResponse 有 seek 方法但一调就抛
    # io.UnsupportedOperation（它只是占位实现），不能靠 hasattr 判断！
    seek_ok = False
    seek = getattr(resp, "seek", None)
    if callable(seek) and getattr(resp, "seekable", lambda: False)():
        try: seek(spec.start); seek_ok = True
        except (OSError, ValueError): pass
    if not seek_ok:
        remaining = spec.start              # 读掉前缀，等效 seek
        while remaining > 0:
            chunk = resp.read(min(CHUNK, remaining))
            if not chunk: break
            remaining -= len(chunk)
```

**经验**：「hasattr 判断能力」在 Python 标准库里会翻车——有些对象有方法名但实现是 raise。用 `getattr(x, 'seekable', ...)()` 查能力标志更可靠。

**测试策略**：假 WebDAV 服务器专门做一个 `norange` 模式（无视 Range 永远回 200），17 个测试用例覆盖首段/中段/尾段/精确区间/连续拖动，逐一比对与全量流的内容一致性。

## 四、扫描任务：状态机 + 竞态控制

扫描是后台线程 + 前端轮询的组合，这里集中了本项目最多的竞态坑。

### 坑 1：暂停接口「立即返回但未生效」

`pause` 只是把 `control` 标志设为 `"pause"`，**真正标记 state=paused 的是扫描线程**——它要跑到下一个文件检查点（最长 0.25s 限流间隔 + 一次网络往返）。如果接口立即返回，前端第一次拉状态拿到的还是 `running`。

**修复**：接口设完标志后，在锁外短等线程确认（≤1.2s），确认后才返回：

```python
if action in ("pause", "cancel"):
    deadline = time.time() + 1.2
    while time.time() < deadline:
        with _tasks_lock:
            t = _tasks.get(tid)
            if t and t["state"] in ("paused", "cancelled", "done"):
                return dict(t)          # 线程已确认
        time.sleep(0.04)                # 锁外等待，不阻塞线程拿锁
```

**思路**：「设置标志」和「状态生效」是两件事，跨越了线程边界。凡是「请求别人做事」的接口，要么同步等到可见，要么返回「已受理」并让前端轮询——最忌返回一个介于两者之间的假状态。

### 坑 2：任务字典被旧任务覆盖（最隐蔽的 bug）

前端 `this.tasks[sourceId] = task`，而 `/api/tasks` 返回**按 id 降序**的列表。同一个源有多个历史任务时，**最旧的 done 任务最后写入，把刚设置的 paused 状态覆盖掉**。UI 表现为「暂停后永远显示扫描中」，且 Because 前端状态机 `_scanState` 也卡住，重启页面才能恢复。

**排查过程**（值得记录的方法论）：
1. 后端加审计日志 `control_task` 记录每次 action → 发现 pause 确实生效
2. 前端挂 `window.__srcMgr` 调试句柄，暂停后直接读运行时 `this.tasks` → 发现 state=done（而非 paused）
3. 对照 `/api/tasks` 原始返回（浏览器内 fetch）→ 发现列表里有多个同源任务
4. 意识到覆盖问题

**修复**（双保险）：前端只取每源第一条（最新）；后端 `list_tasks` 同源去重：

```python
def list_tasks():
    ordered = sorted(_tasks.values(), key=lambda t: -t["id"])[:50]
    seen, out = set(), []
    for t in ordered:
        if t["source_id"] in seen: continue
        seen.add(t["source_id"])
        out.append(dict(t))
    return out
```

**经验**：**「以业务实体为 key 的字典 + 列表数据源」**是最常见的覆盖 bug 源。凡是 `for x in list: dict[key(x)] = x`，都要问一句：list 里同一个 key 会出现几次？顺序保证是什么？

### 坑 3：轮询全量重建 DOM，按钮点击落空

扫描中每 1.5s 全量 `render()` 重建卡片。用户点「暂停」的瞬间，按钮 DOM 被销毁重建——**真人和自动化测试都会点空**（Playwright 报 element is not stable 或静默点旧节点）。

**修复**：渲染分两级：

```js
render() {
    if (this._tryUpdateProgressInPlace()) return;  // 只改文字/进度条/按钮字
    this._renderFull();                             // 结构变化才重建
}
```

**思路**：轮询更新的目的只是「数字在动」，那就只动数字。判断「能不能原地更新」的依据是**结构是否变化**（扫描开始/结束、源增删、启停切换）。

**副产品**：`overflow: hidden` 裁掉下拉菜单——`.src-card` 的 overflow:hidden 是为顶部色条圆角设的，但「更多」菜单是卡片子元素，向下弹出整个被裁。菜单 DOM 状态 open+visible 但视觉消失。修：去掉 overflow:hidden，色条圆角由 `::before` 自己的 `border-radius` 保证。

**经验**：`overflow: hidden` 是个容易忘的隐形杀手。任何下拉/弹出层，检查所有祖先的 overflow。

### 坑 4：僵尸 paused 任务

暂停后任务 state=paused 永远挂着（线程在忙等）。两个连带问题：
- `active_task_for` 原来不含 paused → 暂停期间还能再开新扫描 → **双任务**，pause/resume 作用到僵尸上，新任务失控
- 页面刷新后 `this.tasks` 为空，轮询没启动（只在点扫描时启动）→ 僵尸任务显示成「扫描中·0文件」且无法从 UI 恢复

**修复**：
1. paused 计入活动任务（暂停 = 仍有任务占用，必须先 resume 或 cancel）
2. `load()` 检测到 `scan_running` 自动接上轮询——刷新页面不丢状态

**经验**：状态机里每个状态都要回答「谁负责离开这个状态」。paused 的出口是 resume/cancel，且必须在 UI 上可达。

## 五、CSS 类名同步：写了规则没人用

`.sources-view { padding: 16px }` 写在 CSS 里，但 JS 创建元素时写的是 `class="view"`——**这条规则从第一天起就没生效过**，数据源页一直贴边。靠逐页截图审查才发现。

**系统性排查方法**：grep CSS 里所有类选择器 vs JS 里所有 `class: '...'`，做差集。

**预防**：本项目的教训是「CSS 先行、JS 后写」时最容易发生。要么先写 HTML/JS 结构再补样式，要么用一条集成测试检查关键容器的 computed padding。

## 六、内联样式压死断点规则

「单独筛选」分组标签在平板图标条模式下要隐藏：

```js
el('div', { class: 'side-group-label',
    style: { ..., display: 'block' } })   // ← 内联 display
```

```css
@media (max-width: 1023px) {
    .sidebar .side-group-label { display: none; }   /* 被 inline 干掉 */
}
```

内联样式优先级高于任何选择器（除非 !important）。**修复**：删掉内联 display，让默认文档流生效。

**经验**：`el()` 这类 DOM 工厂函数的 style 参数只放「值」，不放「开关」。开关一律走 class。

## 七、缩略图：`<img src="video#t=1">` 是无效用法

最初媒体库用 `<img src="video.mp4#t=1">` 当封面——**浏览器不会为 img 解码视频流**，全部显示灰色占位。唯一纯前端方案是真挂一个 `<video>` 解码后 canvas 截帧：

```js
const video = document.createElement('video');
video.muted = video.playsInline = true;
video.src = streamUrl;
await waitEvent(video, 'loadedmetadata');
video.currentTime = 1.0;                       // 1s 处截帧，避开黑帧
await waitEvent(video, 'seeked');
canvas.getContext('2d').drawImage(video, 0, 0, w, h);
return canvas.toDataURL('image/jpeg', 0.72);
```

**工程约束**：
- **并发限 3**：一页 48 个视频同时解码会打爆带宽和内存，用队列 + `inflight` 集合做泵
- **失败也缓存**（`cache.set(key, undefined)`）：坏文件不能反复重试
- **离屏 video 也要挂 DOM**：Safari 要求在文档中才解码，`left:-9999px` 隐藏
- **canvas 污染**：同源流没这个问题，但如果换成跨域直链，必须 `crossOrigin='anonymous'` 且服务器带 CORS 头，否则 `toDataURL` 抛 SecurityError

**测试素材的坑**：用随机字节伪装视频文件，浏览器根本无法解码（metadata 都出不来），截帧永远失败——且 Playwright 的 Chromium 是开源构建**不带 H.264 解码器**。最终用 `MediaRecorder + canvas.captureStream()` 在浏览器里生成真 VP8 webm 作测试素材。**教训**：测试数据的「形似」不等于「真」，媒体类测试必须用真实编码的文件。

## 八、测试基建：这个项目最值钱的部分

### 假 WebDAV 服务器（tests/fake_dav.py）

用 `ThreadingHTTPServer` 实现 PROPFIND + GET + Range + Basic Auth，三种模式：
- `good`：正常，支持 Range
- `auth`：强制 Basic 认证（验证凭据传递与错误提示）
- `norange`：故意无视 Range 回 200 全量（验证本地裁剪）

夹具含**中文名、空格名、嵌套目录、24 个批量子目录**——中文与空格是最容易在 URL 编码上翻车的场景；批量目录把扫描拉长到 7.5s，给「暂停/停止」测试留出操作窗口。

**坑**：目录直属判定用「路径段数」而不是「有没有斜杠」——`/视频/子目录/深层.mp4` 对 `/视频/` 来说是隔层，不能因含斜杠被误判为直属。

### run_all.py 的端口清理

Windows 的 `SO_REUSEADDR` 允许两个进程同时 bind 同一端口——残留的旧假服务器会让新进程变成「影子」，请求全被旧进程接走，auth 模式测试诡异地通过/失败。修：

```python
def kill_port(port):
    out = subprocess.run(["netstat", "-ano"], ...).stdout
    pids = {int(p[4]) for p in map(str.split, out.splitlines())
            if len(p) >= 5 and p[3] == "LISTENING" and p[1].endswith(f":{port}")}
    for pid in pids:
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], ...)
```

**经验**：集成测试的第一个失败往往不是被测代码，而是环境残留。测试入口先清场，且清场要能对付「双绑定」这种平台怪癖。

### 测试自污染

清场脚本「无条件 cancel 所有源」会把上一轮**故意暂停**的任务继续→取消，污染本轮被测状态。`scan.log` 的时间线（继续→取消发生在同秒）是定位关键。

**修复**：只 cancel 真正 stale 的（pending/running/paused 且非本轮创建），清场后 reload 让前端回到确定状态。

**经验**：测试的 setup 和 teardown 本身也是「生产代码」，同样会引入竞态。凡是跨用例共享的服务端状态，setup 要「按需最小干预」。

### 重大事故：测试清空了用户数据

本项目最严重的一次过失。`test_e2e.py` 开头有一段「清掉旧数据」——把服务里**所有数据源逐个 DELETE**——而它一直打在**用户正式数据的 8771 端口**上。结果：用户刚配置好的网盘源（含密码）被测试删光，且无备份不可恢复。用户反复重配、反复被清，直到第三次问「为什么又初始化了」才定位到是测试干的。

**修复（测试全面隔离）**：
1. 端口隔离：所有测试固定打 **8792**（假 WebDAV 8898），用户服务 8771/8899 永不相碰
2. 数据隔离：测试服务通过 `WEBSUA_DATA=data-test` 用独立数据目录
3. `run_all.py` 的 `kill_port` 也只清理测试端口，永不误杀用户服务
4. 模拟「远端文件消失」不再直接改用户 SQLite 文件，改为对假服务器发真实 WebDAV DELETE

**教训（代价最大的几条）**：
- **测试对共享环境的任何写操作都是事故隐患。** 隔离不是「以后再做」的优化项，是测试存在的
  前提。基础设施能力（`WEBSUA_DATA` 环境变量）从第一天就有，但没被使用——**能力存在 ≠ 被使用**。
- 「直接改 SQLite 文件模拟状态」是同一性质的双重越界（改的还是用户库）。
- 用户报告「数据被初始化/文件丢了」时，**先怀疑自己的测试链路**，再怀疑产品代码。
- 给数据加一层「源配置导出/备份」能救场；至少让可恢复性成为设计考虑。

## 九、前端细节坑合集

| 坑 | 现象 | 修法 |
| --- | --- | --- |
| `element.className = 'x'` 覆盖 | 外层 `view active` 被抹掉，两个视图同屏 | 用 `classList.add` |
| flex 子项缺 `min-height: 0` | 拒绝收缩，滚动吸附失效，内容堆叠 | 显式 `min-height: 0` |
| bytes 字面量含中文 | `SyntaxError`（bytes 只能 ASCII） | `json.dumps(...).encode()` |
| `__slots__` 漏属性 | `AttributeError: no __dict__` | 加全 slot 名 |
| 中文查询参数未编码 | `UnicodeEncodeError` | `urllib.parse.quote()` |
| URL 无协议头自动补 https | 打死内网 http 服务 | 按主机名判断（192.168./localhost/.local → http） |
| 主题图标没 class | CSS 状态切换全失效，三个图标同显 | SVG 工厂支持 className 参数 |
| `<head>` 主题脚本慢于样式 | 明暗切换闪白 | 内联脚本放样式 link 之前 |
| 模态框 Escape 监听泄漏 | 叠开的弹窗互相干扰 | 打开时注册、关闭时移除 |
| 菜单「点外部关闭」监听泄漏 | 每次渲染注册一个 document 监听 | `{ once: true }` + 打开时才挂 |

## 十、设计思路沉淀

**1. 双端点回退是流播放的保险丝。** 主端点（Range 代理）覆盖 99% 场景，备用端点（全量直读）兜底各种服务器怪癖。播放器里三条看门狗（超时/停滞/卡死）+ 端点回退 + 重试上限，形成完整的降级链：自动重试 → 切端点 → 报错露重试按钮。所有失败出口收敛到一个幂等函数 `notifyPlaybackFailure`，保证一次播放只回调一次 onError。

**2. 视口化（windowing）是长列表的唯一出路。** 竖屏流只给当前条目挂播放器，离开即销毁（`removeAttribute('src') + load()` 立即释放连接），IntersectionObserver threshold 0.6 判定当前条目。接近底部才预取下一批。

**3. 乐观更新 + 服务端兜底。** 收藏、进度先改内存再异步上报；进度用 `sendBeacon` 在页面卸载时兜底（fetch 会被浏览器取消）；启动时全量拉一次进度到内存，续播同步生效不等接口。

**4. 凡是「请求别人做事」的跨线程接口，返回前要确认生效。** 这是本项目最贵的一课（坑 1 + 坑 2 都源于此）。要么同步等到可见，要么明示「已受理」+ 前端轮询，绝不返回中间态。

**5. 截图审查胜过想象。** `audit_ui.js` 一次产出 3 断点 × 12 场景截图，贴边/溢出/裁剪/状态错误肉眼立现。本项目最后三个 CSS bug（菜单被裁、padding 未生效、内联样式压断点）全是截图审查抓的，代码 review 没看出来。

**6. 会话恢复的两个隐蔽坑。** 「恢复上次播放」看似简单，踩了两个坑：
- **`scrollIntoView` 在 `display:none` 容器上不生效** —— boot 阶段还没切视图，视频流容器是隐藏的，滚动位置永远是 0。必须先切视图让容器可见再滚动。
- **`random` 顺序不可复现** —— SQLite `RANDOM()` 每次请求都重新洗牌，上次的 mediaId 在恢复时根本定位不到。恢复会话时把 random 转成「最近」确定性排序，才能精确定位。「恢复」的语义是继续上次播放，而非复现当时的随机队列。

**7. 「以业务实体为 key 的字典」和「随机序」都要问一句可复现性。** 会话/分页/队列这类「要能还原状态」的功能，底层数据源必须是确定性的；随机是体验糖，不能作为持久化锚点。

---

## 十一、真实网盘实战：123 云盘踩坑全记录

假服务器上一切正常，接上真实的 123 云盘（TB 级、4.5 万文件）后连续暴露四个问题。
**假数据永远无法替代真实环境的怪癖**，这一节是拿真实数据学费换来的。

### 坑 1：环境代理劫持 TLS —— 「你的程序连不上我的网盘」

症状：`SSL: UNEXPECTED_EOF_WHILE_READING`，TLS 握手阶段被切断。
根因：运行环境设了 `http_proxy` 环境变量，**urllib 默认读它走代理**，代理把 123 的
TLS 连接掐了。

**决策**：WebDAVClient 的 opener 显式加 `ProxyHandler({})` 强制直连。理由——
WebDAV 地址是用户显式配置的，客户端应该直连它；环境代理是为浏览器流量准备的，
不该劫持显式指定的服务器连接。

**经验**：任何「连接失败」类问题，第一件事确认有没有代理插在中间（环境变量代理、
系统代理、VPN/加速器）。这个检查花 1 分钟，盲查代码可能花 2 小时。

### 坑 2：间歇性 TLS 握手抖动 —— 重试机制的覆盖盲区

症状：同一文件连续三次 Range 拉流——0.8s 成功 / **32.7s 成功** / 0.7s 成功。
32.7s 的那次内部经历了两次 TLS 握手超时后第三次成功。**123 云盘的连接抖动是常态。**

更深的坑：项目明明有完整的重试机制（限流/5xx/429），但**连接层错误从不重试**——
`WebDAVError` 对连接类错误抛出时不带 status（默认 0），而 `_retryable_status(0)`
为 False。等于重试机制形同虚设于最需要它的场景。

**修复**：
1. `_retryable_status` 把 `status == 0`（连接/网络层，无 HTTP 状态码）纳入可重试
2. `stream()` 打开阶段新增 `_open_retry`：短超时（15s）快速失败快速重试（2 次），
   一旦打开成功，读取阶段不再受限——**握手要快失败，读流要耐得住慢**

**经验**：写完重试机制要专门问一句「**哪类错误会被排除在重试之外？这些场景真的不该重试吗？**」
错误分类（确定性错误 vs 瞬态错误）比重试循环本身更重要。

### 坑 3：大目录静默跳过 —— 扫出 4697 vs 网盘实际 44674

症状：扫描「成功」完成，但文件数只有网盘显示的 10%。进度在某处不动几分钟后突然完成。

根因链条：
1. TB 级网盘的大目录（上万文件）PROPFIND 响应很慢，30s 默认超时不够
2. 重试 3 次全超时后，遍历器把该目录**静默跳过**（`continue`，无日志）
3. 整个目录子树的文件无声消失——几万个文件没了，日志一个字不提

**修复**（三层）：
1. **超时放宽**：扫描 HTTP 超时 30s → 120s（大目录响应慢是正常的，等得起）
2. **失败绝不上报为成功**：`list_tree` 新增 `on_error(路径, 错误)` 回调，每个失败目录
   写 error 日志；任务摘要带 `failed_dirs` 计数，完成时显示
   「⚠ N 个目录失败被跳过（建议重扫）」，卡片出黄条
3. **精细进度日志**：每 25 目录 / 每 500 文件记一条进度——没有它，用户面对「4600 不动了」
   无法区分「大目录慢」还是「卡死」

**经验**：**「静默降级」是数据完整性问题的头号来源。** 每一处 `except: continue` 都要问：
被跳过的东西用户在乎吗？在乎就必须可观测（日志 + 汇总计数 + UI 提示），三者缺一不可。
「扫描成功但少了 90% 的文件」比「扫描失败」恶劣得多——失败会有人看，静默的残缺没人知道。

### 坑 4：改表字段的三处同步

给 `sources` 表加 `exclude_dirs` 字段时，INSERT 的**列清单**和**占位符**忘了同步
（只加了参数值），运行时炸 `Incorrect number of bindings`。

**经验**：手写 SQL 的表字段变更涉及四处：CREATE TABLE、ALTER 迁移、INSERT 列清单+
占位符、UPDATE 白名单。加一个字段过一遍这个 checklist，一处都不能漏。
（这也是为什么很多团队宁可用 ORM——迁移成本换类型安全。零依赖项目只能靠纪律。）

### 调优建议（TB 级网盘）

| 场景 | 建议 |
| --- | --- |
| 数万文件扫描太慢 | `WEBSUA_SCAN_RATE=0.1`（VIP 网盘限流压力小），秒 10 请求 |
| 扫描出的数量与网盘对不上 | 看 `scan.log` 里的「目录列举失败」行，失败目录重扫即可补全 |
| 播放偶发卡顿/报错 | 三层兜底已自动处理（stream 重试 → 播放器重试 → proxy 端点）；频繁出现查日志里的「播放失败」行 |

---

## 十二、下一步方向：官方 API 扫描 + WebDAV 播放（设想、风险与待验证清单）

> **状态：设想 / 未实现。** 这一节不承诺任何功能，只记录「为什么需要换路子、可能怎么走、
> 走之前必须先验证什么」。代码里目前**只有 WebDAV 一条扫描通道**，本节的方案尚未落地。

### 12.1 为什么 WebDAV 这条路走不到 TB 级

真实体感（TB 级、4.5 万文件、123 云盘 VIP）：

- **加载列表本身就慢**：`PROPFIND Depth:1` 一次只拿一层，目录里上万文件塞在一个响应里，
  大目录响应几十秒是常态。老手用 WebDAV 多年都清楚——这不是偶发卡顿，是协议形态决定的
- **没有分页游标**：WebDAV 列表要么整体返回、要么 401/207 分块，拿不到
  「下一页 offset/maxId」这种可续传的句柄。所以扫描**无法断点续扫**，中断就得从头再来
- **进度是假的**：目录总数未知，进度条只能按「已遍历目录数 / 预估上限」封顶 92%，
  「还剩多少」永远是黑箱
- **串行 + 限流**：`SCAN_RATE=0.25s` 保证每次 PROPFIND 至少间隔 0.25s，总耗时 ≈ 目录数 ×
  (限流 + 响应)；光是 0.25s 的排队在数千目录上就是十几分钟，还没算慢响应和重试
- **大目录超时会吞掉整个子树**（坑 3 已经踩过：扫出 4697 vs 实际 44674，缺 90%）

**结论**：WebDAV 适合「小型、稳定、已经有现成挂载的网盘」；对于 TB 级 / 十万文件量级，
**把它当 Scan 通道是错配**。而**播放**走 WebDAV 其实完全可以——真正的槽点只在扫描列表。

### 12.2 方向 A（首选）：123 Open API 扫描，播放仍走 WebDAV

**核心思路：扫描通道和播放通道解耦。**

```
                扫描（要快、要全）          播放（要稳、要能 Range）
              ┌────────────────────┐      ┌──────────────────────┐
              │ 123 Open API       │      │ WebDAV GET + Range   │
              │ file/list 分页递归  │      │ （现有链路，零改动）  │
              └────────────────────┘      └──────────────────────┘
```

- 用 `file/list(parentId, limit, maxId)` 递归列目录，**自带分页、速度可控、可精确统计总数**
- 播放继续走 `/api/stream/{id}` → WebDAV，因为它是用户显式配置的地址、已验证可用、Range 稳

**这样做的好处**：改动面最小（只动扫描器），播放侧的抖动/重试/看门狗全部不用重做；
扫描能拿到 `size / createTime / isFolder / thumb` 等元数据，比 PROPFIND 的解析干净得多。

**预测会踩的坑（还没写一行代码，先把雷排一遍）：**

| # | 坑 | 预判与对策 |
| --- | --- | --- |
| 1 | **下载直链有效期** | 网盘直链通常几分钟~数小时过期。**绝对不能把直链写进 `media` 表**；只能内存缓存 + TTL，过期按需重取。这也决定了「方向 A」里播放仍走 WebDAV —— 一旦换成直链播放，恢复进度/换源/重启都要重新换链，复杂度翻倍 |
| 2 | **access_token 过期与刷新** | 需要 refresh_token 持久化（存数据源配置）、进程重启可用；**clientSecret / token 绝不能出现在日志、UI、报错信息里**（现有「密码不外泄」那条测试要同步扩到 API 凭据） |
| 3 | **开发者资质门槛** | Open API 要注册应用、拿 clientID/Secret、过 scope 审核（是否含 `file:list` / `file:download`）。**没过审就得退回方向 B**——这是最大的外部不确定性，所以列为 Step 0 验证项 |
| 4 | **分页语义** | `maxId` 是「游标还是 offset」、`limit` 上限多少（200？）、排序字段必须固定，否则翻页翻出重复/漏项 → 会直接复现 `UNIQUE constraint` 冲突 + 数量对不上 |
| 5 | **同名/移动/删除** | 远端文件改名或移走后，`remote_path` 失配；`bulk_upsert_media` 现在靠「同批 `seen` 去重 + ON CONFLICT DO UPDATE」，API 模式必须重新验证这条路径 |
| 6 | **环境代理劫持（复现）** | 坑 1 已经踩过一次：urllib 默认吃 `http_proxy`。API 请求要不要强制直连/走代理，要在 Step 0 用 curl 实测确认，不能想当然 |
| 7 | **UI 语义变化** | 数据源编辑要加「扫描协议」下拉（WebDAV / 123 API）；API 模式有 total，进度条可以从「封顶 92%」升级成**真实百分比**；暂停/继续的语义页数游标怎么回退也要定义 |
| 8 | **测试面扩大** | 假 WebDAV 已有（`tests/fake_dav.py`），API 模式要配一个假 123 接口；`run_all.py` 的隔离（8792/8898 + `data-test`）机制可直接复用，**绝不重演「测试清掉用户数据」那次事故** |

### 12.3 方向 B：不改架构，先用现有能力把 TB 级扛过去

如果 API 走不通（没权限 / 审核过不去），这几招是**当天就能做**的：

| 手段 | 说明 | 代价 |
| --- | --- | --- |
| 调参 | `WEBSUA_SCAN_RATE=0.1`（VIP 限流松）、`SCAN_HTTP_TIMEOUT` 再放宽 | 还是慢，只是少跳目录 |
| 排除目录 | `exclude_dirs` 排除 TG 导出附属目录、临时目录、已完成的项目目录 | 需要你知道目录语义 |
| **增量扫描** | 记录上次扫描的 (path, size, mtime)，本次只 upsert 变化项，未变化的跳过落库校验 | 仍需遍历目录列举，只是少了写库；但能避免 UNIQUE 冲突和重复劳动 |
| **分根扫描** | 把 TB 盘按顶层目录切成多个数据源，分批扫（今天扫 A 区、明天扫 B 区） | 媒体库要跨源聚合展示（现在已支持多源） |
| 只扫不播链路保留 | 扫描仍是 WebDAV，但把「已确认会被超时吞掉的目录」显式排除 | 治标 |

**个人判断**：方向 B 里最有价值的是「增量扫描 + 分根扫描」——它改善的是**体感和可靠性**，
不改善**单次数小时**这个硬伤。想真正解决 TB，还是得方向 A。

### 12.4 方向 C（通用化）：把扫描器抽象成 provider

现在 `list_tree()` 事实上已经是 provider 接口了；接上 123 之后它就是**名副其实的抽象层**：

```python
# 统一 item 契约（无论什么协议）
{ "name": str, "path": str, "size": int, "mtime": float, "is_dir": bool }
# provider 只需实现：list_dir(path) -> items（内部自行分页/限流/重试）
```

顺带可复用给其他有 Open API 的网盘（115 / 阿里云盘 / 天翼 / 坚果云 / PikPak…）。

**但抽象是有成本的**：接口一开，配置面、测试面、UI 分支都变大。判断标准很简单——
**「这个抽象现在有几个实现类？只有一个就别抽」**。所以顺序是：
先真做出来 123 provider，再谈通用化；在只有一个实现的时候抽接口，只会得到一个空壳。

### 12.5 落地顺序（小步验证，别一上来写全）

```
Step 0  用 curl 手测：token → file/list（含大目录）→ download
        ✅ 不写项目代码。不确权就不动手，避免白干
Step 1  backend/pan123.py：token 管理 + 分页 list（只做扫描，先不做播放）
Step 2  scanner 分派 protocol + db 加 provider 列 + UI 下拉（默认仍是 WebDAV，向前兼容）
Step 3  播放：先保持 WebDAV 不动；真挂了再上「直链 + TTL 缓存 + 过期重取」
Step 4  假 123 接口 + 回归测试 + 本 README 补真实踩坑（这次是真实数据，不是预测）
```

**硬性纪律**：Step 2 的 `protocol` 列**默认必须仍是 `webdav`**，旧配置零改动可用；
新增配置项只增不改，否则又是一次「改表字段四处不同步」（坑 4）。

### 12.6 还没开始做，但已经「知道会踩」的坑（预告清单）

- token / 直链**过期时间**要显式的 TTL 常量和过期日志，不能静默 401 后继续喂直链
- 凭据**脱敏**：任何 `print()`、异常 message、前端返回都要避开 clientSecret/token
- 扫描协议切换时，UI 的乐观更新不能把「扫描中」画在错误的协议上（竞态）
- 分页游标持久化后，重扫已有目录要走增量而不是全量 upsert（否则 UNIQUE 冲突高发）
- 「扫描完成」的语义必须包含失败计数，沿用坑 3 那条铁律：**静默降级是数据完整性问题的头号来源**

### 12.7 待验证清单（动手前要把这些问清楚）

1. 账号是否开通 123 Open API？clientID / Secret / scope 是否含 `file:list`、`file:download`？
2. 真实分页参数：limit 上限、`maxId` 是游标还是 offset、固定排序字段是什么？
3. `file/list` 是否返回 `thumb` 缩略图 URL？（**若能，TG 封面那套命名匹配 hack 可以整套删掉**）
4. 下载直链有效期多久？是否需要额外签名 header？
5. 限流 QPS 是多少？VIP 与普通账号有没有差异？
6. **万级子项的大目录能否完整分页返回？**——WebDAV 正是栽在这一条，API 必须实测确认

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WEBSUA_DATA` | `./data` | 数据目录 |
| `WEBSUA_SCAN_DEPTH` | `8` | 扫描最大目录深度 |
| `WEBSUA_SCAN_RATE` | `0.25` | PROPFIND 最小间隔（秒），防限流；VIP 网盘可调 0.1 |
| `WEBSUA_SCAN_RETRIES` | `3` | 限流/服务器错误/连接错误重试次数 |
| `WEBSUA_SCAN_BACKOFF` | `1.0` | 退避基数（指数：0.5s, 1s, 2s…） |
| `WEBSUA_SCAN_429_WAIT` | `5.0` | 429 额外等待秒数 |
| `WEBSUA_SCAN_HTTP_TIMEOUT` | `120` | 扫描 HTTP 超时（秒）；大目录响应慢，调大可减少目录跳过 |
| `WEBSUA_SCAN_LOG_EVERY_DIRS` | `25` | 每遍历多少目录记一条进度日志 |
| `WEBSUA_SCAN_LOG_EVERY_FILES` | `500` | 每发现多少文件记一条进度日志 |
| `WEBSUA_VERBOSE` | — | 打印 HTTP 访问日志 |

**规划中（尚未实现，预留位）**：`WEBSUA_API_PROTOCOL`（数据源级「扫描协议」默认项，
`webdav` / `123api`）、`PAN123_CLIENT_ID`、`PAN123_CLIENT_SECRET`、`PAN123_TOKEN_TTL`、
`PAN123_LINK_TTL`、`WEBSUA_API_RATE`。**未实现前不要写进 `.env`**，写了也不会生效。

## 常见问题

**Q：扫描出的文件数和网盘显示的对不上？** 先看扫描摘要/日志里有没有「⚠ N 个目录失败被跳过」——
大目录超时会导致整个子树被跳过，重扫失败目录即可补全。若没有失败记录，检查是否设置了排除目录、
是否超出 8 层深度（`WEBSUA_SCAN_DEPTH`）。也可以排除 TG 导出的附属文件夹减少噪音。

**Q：扫描中途「进度不动了」？** 大目录（上万文件）的 PROPFIND 响应本来就要几十秒，
超时放宽到 120s 后多数能等到；若最终日志出现「目录列举失败」说明该目录被跳过（可重扫补全）。

**Q：视频播不出来？** 播放器「更多 → 调试日志」打开能看到具体原因（认证失败/文件不存在/格式不支持）；
`data/scan.log` 里的「播放失败」行带远端路径与状态码，适合反馈排查。123 云盘连接有间歇性抖动，
内置的重试链（stream 重试 → 播放器看门狗 → proxy 端点回退）会自动处理大部分瞬态失败。

**Q：TG 导出的缩略图还单独出现在媒体库里？** 确认数据源已开启「TG 导出封面」并**重新扫描**——
匹配发生在扫描时，旧扫描的关联不会自动补上；匹配成功的缩略图会被剔除出媒体库。

**Q：TB 级网盘扫不完 / 扫一次要几小时，有根治方案吗？** 根治方向是**官方 API 扫描 + WebDAV
播放**（扫描走 `file/list` 分页，播放仍走现有 Range 链路），设计、风险与待验证清单见
**[十二]**。在那之前只能靠调参 + 排除目录 + 分根扫描扛，其中「增量扫描 + 把大盘按顶层目录
切成多个数据源分批扫」性价比最高。**注意：该方案尚未实现**，当前版本仍然是纯 WebDAV 扫描。

**Q：自签名证书？** 暂不支持。内网可用 `http://` 地址（会自动识别内网主机名补 http）。

**Q：想精确缩略图？** 当前纯前端截帧（视频第 1 秒），TG 封面模式可让有封面的视频直接用图。要 ffmpeg 级精确缩略图需加后端依赖，暂未引入以保持零依赖。

## 测试

```bash
python tests/run_all.py            # 一键：起隔离服务 → 三套后端回归 → 自动清理
python tests/run_all.py --env-only # 只起隔离测试环境（调试单个测试时用，Ctrl+C 退出）
node tests/test_browser.js         # 浏览器 60 项（需先起隔离环境）
node tests/test_ui_polish.js
node tests/test_pagination.js
node tests/test_history_tg.js
node tests/audit_ui.js             # 全页面截图审查
```

**测试与用户数据完全隔离**：所有测试跑在 **8792 端口**（假 WebDAV 在 8898），数据目录是
独立的 `data-test/`——测试里的「清空数据源」「停用源」「删除远端文件」等破坏性操作
只会作用于隔离实例，**永远不碰你正式的 8771 服务和 `data/` 目录**。历史教训：早期
test_e2e 直接打主服务并把所有数据源「清掉旧数据」，把用户刚配好的网盘源删光了。
