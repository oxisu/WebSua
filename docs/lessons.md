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

### 坑 5：轮询结束不刷新 sources 快照，卡片冻结在「扫描中」

扫描完成的轮询周期里，`running` 变 false → 重置 `_scanState` → 停轮询 → 走 `onChanged()`。但 `onChanged` 只刷侧栏和视频流，**没有刷 SourceManager 自己的 `this.sources`**——快照里 `scan_running` 还停在开扫前的 `true`。于是下一次 `render()` 的「原地更新」判定继续认为在扫描中：文字定格在最后的进度数字，「扫描完成」状态区永远渲染不出来，而且没有任何后续轮询来纠正它。

**修复**：两处一起补——
1. 轮询检测到「本轮扫描全部结束」时 `await this.load()`，把源快照拉到最新（`last_scan_at`、`resumable`、`item_count` 也一起更新）
2. 「能不能原地更新」的判定改为**任务状态优先**：有任务记录时以它为准，没有任务记录（刷新页面后的首次拉取前）才退回 `scan_running`

**经验**：轮询循环里「渲染用的数据」和「轮询拉取的数据」必须是同一份。凡是轮询只更新部分状态（tasks）而渲染读另一部分（sources），就要问一句：快照什么时候过期？另外，这个 bug 是**给「增量扫描」写 UI 测试时才暴露的**——此前没有任何测试驱动扫描在 UI 上跑完，所有人（包括自动化）都通过「扫完刷新页面」绕过了它。**新功能的测试往往会照亮老功能的暗角。**

### 坑 6：开扫后立刻渲染，用的是上一个任务的残留进度

点「扫描」→ `render()` 发生在 `await api(scan)` **之前/同时**，而任务列表要等 1.5s 后的首次轮询才更新。这 1.5s 里状态区显示的是上一个任务的最终进度（「已遍历 25 目录 · 已发现 24 个文件」），然后才跳回 0 开始涨——真人视角就是「进度条假跳」。

**修复**：`api(scan)` 返回后立刻补拉一次 `/api/tasks` 再进轮询。

**经验**：乐观更新的本质是「先用旧数据占位，再用新数据纠正」。占位值不能是**语义相反**的旧数据（「已完成」冒充「进行中」），否则在拉正之前的窗口里，UI 在说谎。

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

**8. 绝对定位元素挂在滚动容器内部，会跟着内容一起滚走。** 视频流的「上一条/下一条」按钮是 `.feed`（可滚动容器）的 `position: absolute; top: 50%` 子元素 —— 百分比相对的是**整个滚动内容的高度**，滚到第 8 条时按钮跑到视口上方三千多像素，用户根本点不到。修法：`top: 0` + 在 scroll 回调里用 `transform: translateY(scrollTop + 半屏高 - 半键高)` 反向抵消。这个 bug 是自动化测试点导航按钮时暴露的——Playwright 为了把按钮滚进视口，把视频流瞬间滚回顶部，把队列索引也带偏了。**浮层控件要么放在滚动容器外，要么用 transform 钉在视口上。**

**9. 自然序要显式做，字典序会毁掉「下一集」。** SQLite 的 `ORDER BY name` 是字典序：`第10集` 排在 `第2集` 前面。播放队列这类「按名字连续」的场景必须在取回后用 `re.split(r'(\d+)')` 做自然序键（数字段转 int 比较），并且**先排完再分页**——在 SQL 里 limit 会把排序结果截错。

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
