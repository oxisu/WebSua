# WebSua - 云刷

[![CI](https://github.com/oxisu/WebSua/actions/workflows/ci.yml/badge.svg)](https://github.com/oxisu/WebSua/actions/workflows/ci.yml)

**简体中文** | [English](./README.en.md)

> **WebSua** ("云刷") — Turn videos scattered across multiple WebDAV drives into
> one endless, swipeable stream.
> 多 WebDAV 视频流播放器：把分散在多个网盘里的视频，变成一条可以像刷短视频一样连续播放的视频流。

- **零依赖**：前端原生 ES Module + CSS，后端 Python **纯标准库**，`python main.py` 双击即用
- **多源**：每个 WebDAV 独立成一个文件源，各自扫描、各自筛选
- **三端自适应**：手机（底部标签栏）/ 平板（图标侧栏）/ 桌面（三栏 + 队列）
- **明暗主题**：跟随系统，可手动切换，无闪白
- **TG 封面**：自动识别 Telegram 导出视频旁的同名封面图（可开关）
- **字幕**：自动关联同目录同名 `.srt`/`.vtt`，前端转 VTT 播放，支持开关 / 字号 / 延迟
- **扫描可控**：限流、指数退避重试、暂停 / 继续 / 停止、日志可查
- **媒体库增强**：文件夹树浏览、进度筛选（未看/有进度/已看完）、批量操作、
  重复文件检测、标签自定义分类、按源聚合统计
- **开源协议**：[GNU AGPL-3.0](./LICENSE) —— 二次分发或对外提供网络服务时，须以同一协议开放源码

> 📌 **当前版本只支持 WebDAV 一种扫描协议。** 关于「TB 级网盘改用官方 API 扫描」的
> 方案设想、风险清单与落地步骤，见 **[docs/design-pan123-api.md](./docs/design-pan123-api.md)**
> ——那是设计文档，不是已实现功能。

---

## 快速开始

```bash
python main.py
```

就这一步。首次运行自动创建 `data/library.db` 并打开浏览器。**无需 pip install**。

```bash
python main.py --port 9000        # 指定端口（被占用自动顺延）
python main.py --browser          # 启动并自动打开浏览器（默认不开）
python main.py --scan             # 启动后立即扫描所有数据源

# 局域网访问（手机 / 电视 / 别的电脑）：必须同时设置访问密码，否则拒绝启动
python main.py --host 0.0.0.0 --password 你的密码
```

### 先试试看：一键演示（不需要网盘账号）

手上还没有 WebDAV，或者只是想先看看界面长什么样：

```bash
python demo.py
```

一条命令做完四件事：在本机起一个**假 WebDAV**（内容由程序生成）→ 用**独立的演示数据目录**
`data-demo/` 起一个 WebSua 实例（**绝不碰你的 `data/`**）→ 自动建两个演示源并扫描完
→ 打开浏览器。

演示里能真的播放和拖动进度条（走真实 Range 请求）、有封面、有字幕、有一整季剧集可以验证
「播完自动下一集」，还预置了一条收藏和一条观看进度，界面一打开就是「用过的样子」。

```bash
python demo.py --port 8780        # 换端口（假 WebDAV 默认 8897，会自动顺延）
python demo.py --no-browser       # 只起服务，不自动开浏览器
python demo.py --reset            # 清空演示数据重新来（只作用于 data-demo/）
```

> `--reset` 与 `--data` 都有护栏：**不允许**把演示数据写进真实数据目录 `data/`，
> 也不允许对 `data/` 执行清空。演示数据就是个可随手删掉的沙盒。

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
| 视频流每页条数 | 24 | 视频流滚动到底时每次加载的条数 |
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

### 字幕（同目录同名 `.srt` / `.vtt`）

扫描时把同目录的同名字幕关联到视频上（**字幕文件不单独进媒体库**——它是视频的附属品）：

```
我的影片.mp4 + 我的影片.srt        ← 主规则（同名不同扩展名）
我的影片.mp4 + 我的影片.mp4.srt    ← 变体（视频全名 + .srt）
```

- 后端按**原文**返回字幕，`SRT → VTT` 转换在前端完成，因此后端保持零第三方依赖
- 播放器控制栏新增「字幕」按钮负责开关；「更多 → 字幕设置」可调**字号**（小/中/大）与**延迟**（±0.5s）
- 有字幕时默认显示；无字幕时不出现按钮，`/api/subtitle/{id}` 返回 404
- **不支持 `.ass` / `.ssa`**：样式与定位解析成本高，暂不实现；这类文件会被忽略，不会入索引
- 字幕关联每次扫描时刷新

### 播放队列 / 下一集

右侧「播放队列」面板把「连播」从想法变成显式队列：

- **按目录自然序生成**：播放任意视频时，自动把它所在目录的视频按**自然序**排成队列
  （`第1集、第2集…第10集、第11集` —— 字典序会把 10 排到 2 前面，追剧直接乱套），
  从当前这一集开始。随机视频流负责「发现」，队列负责「连续」
- **拖拽排序**：按住行首把手拖动即可调整顺序；当前播放项不因拖拽而改变
- **循环三态**：关（播完停止）/ 整表循环 / 单集重播，循环按钮循环切换
- **随机播放**：只打乱**播放顺序**（当前项永远置顶），可见列表仍是目录序
- **持久化**：队列存在服务端（只存 id，读取时解析成当前存在的媒体，
  文件被删 / 源被停用自动剔除），刷新、重启、换浏览器都能接着连播
- **清空即关闭**：清空队列会同时关闭自动生成，避免下一跳又建回来；
  在空状态里可以「按当前视频开启」
- 上一条 / 下一条导航、键盘 ↑↓/k/p、自动连播、坏条目跳过，全部沿队列走
- 队列导航会把视频流切成该目录的自然序列表 —— **随机序不可复现**
  （SQLite `RANDOM()` 每次结果不同），拿它当连播锚点会跳错片

### 目录排除

数据源编辑弹窗的「排除目录」输入框（`sources.exclude_dirs`）：

- 逗号分隔**目录名**（中英文逗号均可），如 `抢救（不含文件）,临时`
- 扫描时命中目录名的整个子树被跳过（大小写不敏感）
- 扫描开始日志会记录本次的排除清单，方便核对

### 增量扫描 / 断点续扫

- **增量是重新扫描的默认形态**：扫过的源再点「扫描」自动走增量（首次仍是全量）。
  判定签名 = `size + mtime + 关联封面/字幕路径`，四项全一致的条目**不写库、不刷新
  `indexed_at`**——否则每次重扫都把全表刷成「刚刚入库」，视频流的「最新」排序直接失去意义
- 完成摘要按 **新增 / 更新 / 未变 / 移除** 四段展示（ Toast 同款），扫没扫出东西一眼可见；
  想推倒重来用「更多 → 全量重扫」
- **取消不再丢进度**：停止扫描后，已发现的文件进了暂存表、目录遍历栈已持久化，
  卡片变成「继续扫描 + 放弃」。继续扫描从断点接着走，**不会从根目录重来**；
  刷新页面、重启程序都不影响（勾了自动扫描的源，重启后会自己续上）
- 旧断点在**根目录 / 排除目录 / 扫描深度**变更后自动作废重扫——参数对不上的现场
  比没有现场更危险
- 增量**不减少遍历成本**：PROPFIND 该发还得发（不重列目录就不知道里面多了什么），
  省的是写库放大和「最新」污染。「单次数小时」的硬伤要等官方 API 方案
  （见 [docs/design-pan123-api.md](./docs/design-pan123-api.md)）

### 失败目录重扫 / 扫描差异报告

扫描时某个目录列举失败（大目录超时、权限错误等），**整个子树的文件都会消失**。
这类失败绝不静默丢弃：

- **失败目录持久化**：每次扫描完成后原子刷新，卡片出现红色徽标「⚠ N 目录失败」
  （悬停可看具体路径），而不是只躺在日志里
- **只重扫失败目录**：点卡片上的「重扫失败目录」即可精准复扫，不用把整个源重来一遍。
  这是**局部提交**——只新增/更新这些目录下的条目，其余目录的媒体**一个都不会删**
  （否则「只扫部分目录」会被误判为「其余都消失了」）
- **扫描差异报告**：每次完成的扫描写入一条差异记录（新增 / 更新 / 消失 / 未变），
  **并记录被远端删除的具体路径**，想查「这个文件什么时候没的」有据可查
- 失败目录修好后重扫成功 → 徽标自动消失；仍然失败的目录继续留在列表里，可再次重扫

### 局域网访问密码（门禁）

默认只绑 `127.0.0.1`，**只有本机能访问，不需要密码**。一旦 `--host 0.0.0.0`
暴露到局域网，同一个 Wi-Fi 下任何人都能打开你的媒体库 —— 所以：

- **非本机绑定强制设密码**：没设密码就绑局域网会**直接拒绝启动**，而不是警告后裸奔
  ```bash
  python main.py --host 0.0.0.0 --password 你的密码
  # 或用环境变量：WEBSUA_ACCESS_PASSWORD=xxx python main.py --host 0.0.0.0
  ```
- **统一鉴权**：`/api/*` 全部受保护，**媒体流 / 封面 / 字幕一样要过门禁**
  （只放行登录接口、`/api/auth/status` 与健康检查）。静态资源照常下发 ——
  否则登录界面自己都渲染不出来
- **凭据三种携带方式**：浏览器走 HttpOnly Cookie（`<video>` / `<img>` 的请求
  自动带凭据，前端不用给媒体 URL 拼 token）；脚本用 `Authorization: Bearer <token>`；
  外部播放器（VLC 等）用 `?token=<token>`，登录响应里会直接返回 token
- **密码不明文入库**：pbkdf2-hmac-sha256 + 随机 salt，只存摘要。数据库被拷走
  也拿不到原密码。**改密码会吊销全部已签发令牌**（旧 token 是旧密码签出来的）
- **登录失败限流**：连续错 5 次锁定 60 秒，挡住局域网内的暴力猜解
- 只做**单用户门禁**，不做多用户体系 —— 家庭自用场景一个人够用

### 配置导入导出 / 备份

设置里有「数据备份」：把**数据源配置、前端设置、收藏、观看进度**打包成一个
JSON 文件，换机器或重装后一键恢复。这是「测试清空过用户数据」那类事故的
直接产物 —— **可恢复性必须写进设计**。

- **收藏/进度不按 `media_id` 导出**：`media_id` 是本地自增的，换实例必然对不上。
  备份里用稳定键 `(base_url, root_path) + remote_path`，导入时再按这个键在本地
  重新解析 `media_id`
- **未扫描的媒体会跳过并计数**：新机器上先导入配置、扫描完成后再导入一次，
  收藏与进度就补齐了（不会编造、也不会静默丢弃，汇总里明确告诉你跳过多少条）
- **密码默认脱敏**：只记 `has_password`（是否设置过）。勾选「导出时包含 WebDAV
  密码」才会写入明文 —— 那份文件要当凭据保管
- 逆操作也安全：**导入是合并语义**，绝不删除已有数据；**不会用空密码覆盖已有密码**；
  重复导入幂等（源按地址+根路径更新，收藏不重复）
- 导入前校验：版本号过高、非 WebSua 备份、字段类型不对都会直接 400 并给出原因

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

### 文件夹树浏览

媒体库左侧按 WebDAV **目录层级**浏览，每层显示媒体计数：

- 点击节点即按该目录（**含子目录**）过滤网格，后端用 `folder_prefix` 前缀匹配
- 手机端自动折叠成一条横条，展开才占空间
- 目录树数据源变化时自动刷新（扫描完会看到新目录）

WebDAV 用户习惯按目录找内容，搜索 / 分页补不上这个心智。

### 视图过滤

媒体库筛选栏（全部 / **未看** / **有进度** / **已看完** / 历史 / 收藏）：

| 筛选 | 判定 |
| --- | --- |
| 未看 | 无进度记录，或进度 ≤ 1s |
| 有进度 | 有进度且未看完 |
| 已看完 | `finished` 标记为真 |

可与收藏、搜索、目录树叠加使用。

### 批量操作

点筛选栏「多选」进入多选模式，卡片可勾选（蓝色描边 + ✓ 徽章），底部浮动操作栏：

- **全选 / 反选 / 清除**
- **批量收藏 / 取消收藏**（幂等）
- **批量打标签**：弹窗勾选标签应用到所有选中项，也可输入新标签名「新建并应用」
- **批量移除索引**：**只删本地索引，不删远端文件**，操作前二次确认

### 重复文件检测

按「**文件名 + 大小**」分组找重复组：

- **刻意不上全量哈希** —— 算哈希要把每个文件整个拉一遍，TB 级网盘是灾难；
  (name, size) 已能覆盖绝大多数真实重复（复制备份、重复下载）
- 重复组显示每份所在源与目录，「**保留 1 移除 N**」一键清理多余索引
- 顶部显示「共 N 组重复，可释放约 X」；大小不同的同名文件**不算重复**

### 标签 / 自定义分类

比固定「分类」灵活，但**不做层级嵌套**（保持轻量）：

- 媒体库左侧标签区：列出标签带媒体数，点击筛选，支持新建 / 删除
- 一个媒体可打多个标签；删除标签或媒体时关联自动级联清理
- 删除标签**只删标签，不删媒体**

### 按源聚合统计

数据源卡片展示每个源的：视频 / 图片 / 音频 / 总大小 / **目录数**；
卡片上另有失败目录徽标与最近扫描时间。聚合统计用一条 SQL 取完，
源多时不会 N+1。统计接口挂了也只是没数据，**不会让页面打不开**。

---

## 目录结构

```
WebSua/
├── main.py                 # 启动入口
├── demo.py                 # 一键演示：假 WebDAV + 隔离数据目录（不改配置就能看到完整界面）
├── backend/
│   ├── config.py           # 扩展名/MIME、扫描参数、限流重试参数
│   ├── db.py               # SQLite（单连接 + RLock），含轻量迁移
│   ├── webdav.py           # WebDAV 客户端：PROPFIND（限流+重试）、Range 流读取
│   ├── pan123.py           # 规划中：123 Open API 客户端（token 刷新 + file/list 分页）
│   ├── scanner.py          # 扫描任务：线程 + 暂停/取消 + TG 封面匹配 + 日志
│   ├── stream.py           # HTTP Range 解析与流转发
│   └── server.py           # HTTP 服务：50 个路由 + 静态资源 + 媒体流 + 统一鉴权中间件
├── frontend/
│   ├── index.html          # 内联主题预执行脚本（防闪白）
│   ├── css/
│   │   ├── theme.css       # 设计令牌：明暗主题、断点、间距、动效
│   │   ├── player.css      # 播放器 cvp-* 类
│   │   └── app.css         # 布局、三断点、组件
│   └── js/
│       ├── app.js          # 入口：路由、侧栏、队列面板、设置弹窗
│       ├── feed.js         # 竖屏视频流（窗口化挂载 + IntersectionObserver + 队列导航）
│       ├── queue.js        # 播放队列：目录自然序生成 / 拖拽 / 循环 / 随机 / 持久化
│       ├── grid.js         # 媒体网格（分页 + 缩略图 + 多选 + 重复组）
│       ├── folder-tree.js  # 文件夹树侧栏（递归树 + 展开收起 + 计数）
│       ├── tag-panel.js    # 标签面板（自定义分类：列表/筛选/新建/删除）
│       ├── sources.js      # 数据源管理（状态机 + 细粒度 DOM 更新）
│       ├── video-player.js # 播放器（看门狗 + 端点回退 + 更多菜单）
│       ├── thumbs.js       # 视频截帧（并发限 3 + 失败缓存）
│       ├── progress.js     # 观看进度（节流上报 + sendBeacon 兜底）
│       ├── settings.js     # 前端设置（localStorage + 订阅）
│       └── utils.js        # 请求、格式化、Toast、主题
├── tests/
│   ├── fake_dav.py         # 假 WebDAV（good/auth/norange 三模式，含 24 个批量目录 + 12 集番剧目录；MTIMES 可按文件覆盖 mtime）
│   ├── run_all.py          # 一键回归：自动起服务、切模式、清端口、跑完清理（Windows/POSIX 都支持）
│   ├── test_compat.py      # 仓库级约束 26 项（3.9 语法兼容/注解延迟求值/运行时零依赖/CI 配置不漂移）
│   ├── browser-env.js      # 跨平台探测 Chromium（Win/Linux/macOS + PLAYWRIGHT_CHROME 覆盖）
│   ├── test_e2e.py         # 端到端 36 项
│   ├── test_norange.py     # 服务器忽略 Range 时的本地裁剪 17 项
│   ├── test_edge.py        # 认证/远端删除/密码不外泄 14 项
│   ├── test_subtitles.py   # 字幕关联与读取
│   ├── test_queue.py       # 播放队列：自然序 + 持久化接口 23 项
│   ├── test_incremental.py # 增量扫描与断点续扫 43 项（未变跳过/签名/续扫/取消保留）
│   ├── test_failed_dirs.py # 失败目录重扫 + 差异报告 24 项（持久化/DTO可观测/mode=failed/消失路径）
│   ├── test_failed_dirs_ui.js # 失败目录 UI 9 项（自包含：自带假服务；徽标/重扫按钮/补齐）
│   ├── test_access.py       # 局域网门禁 32 项（拦截媒体流/三种凭据/限流/拒绝裸奔启动）
│   ├── test_access_ui.js    # 门禁登录界面 9 项（自包含；遮罩/错误提示/登录后放行）
│   ├── test_backup.py       # 配置导入导出 27 项（脱敏/跨实例稳定键恢复/幂等/非法 400）
│   ├── test_backup_ui.js    # 备份界面 9 项（自包含；导出下载/导入写入/失败不崩）
│   ├── test_folder_tree.py  # 文件夹树 22 项（嵌套聚合/前缀匹配/源过滤/多层目录）
│   ├── test_view_filter.py  # 视图过滤 9 项（未看/有进度/已看完 + 组合筛选）
│   ├── test_batch_ops.py    # 批量操作 18 项（批量收藏幂等/移除清关联/空列表安全）
│   ├── test_duplicates.py   # 重复检测 13 项（分组/大小不同不算/源过滤/无重复）
│   ├── test_tags.py         # 标签 24 项（CRUD/重名/打标签覆盖/筛选/计数与级联）
│   ├── test_stats_agg.py    # 聚合统计 20 项（分类型计数/目录数/失败目录/空源/多源）
│   ├── test_demo.py         # 一键演示 30 项（真实可播/Range/封面字幕/数据隔离/重启幂等）
│   ├── test_release.py      # 发布资产 38 项（可复现 zip/校验和/解压可 import/CHANGELOG/Release 配置）
│   ├── test_scan_ui.js    # 扫描面板 UI 14 项（增量按钮/完成统计/继续扫描/放弃断点）
│   ├── test_browser.js     # 浏览器 60 项（三断点 × 明暗 × 布局）
│   ├── test_new_features.js# 新功能 8 项
│   ├── test_queue_ui.js    # 播放队列端到端 24 项（自然序/拖拽/循环/清空/下一集）
│   ├── test_ui_polish.js   # UI 打磨 19 项（暂停继续/菜单/折叠/Toast）
│   ├── audit_ui.js         # 全页面截图审查（3 断点 × 12 场景）
│   ├── gen_media.js        # 用 MediaRecorder 生成真 webm 素材
│   └── gen_posters.js      # 生成同名 JPG 封面素材
├── .github/workflows/
│   ├── ci.yml              # CI：三平台 × Python 3.9/3.11/3.13 + 浏览器套件
│   └── release.yml         # 推 v* tag：回归 → 打包 → 创建 Release
├── scripts/
│   ├── package.py          # 打可复现 zip（固定时间戳 + 条目排序 + SHA256）
│   └── changelog_section.py# 从 CHANGELOG 抽版本段落作 Release 说明
├── CHANGELOG.md            # 更新日志（Release 说明的唯一来源）
├── package.json            # 仅开发期依赖（Playwright）；运行 WebSua 不需要 Node
└── data/
    ├── library.db          # SQLite（自动创建）
    └── scan.log            # 扫描日志
```

---

## API 一览

> 开启访问密码后，`/api/*` **全部需要鉴权**（Cookie / `Authorization: Bearer` /
> `?token=`），媒体流与封面同样在内。仅 `/api/auth/login`、`/api/auth/status`、
> `/api/health` 免鉴权。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health`、`/api/stats` | 健康检查 / 全局统计 |
| GET | `/api/auth/status` | 门禁状态（`required` / `authed`），**免鉴权** |
| POST | `/api/auth/login` | 用访问密码换令牌（下发 HttpOnly Cookie，并回传 token），**免鉴权** |
| POST | `/api/auth/logout` | 吊销当前令牌并清 Cookie |
| POST | `/api/auth/password` | 设置 / 修改 / 关闭访问密码（已开启门禁时需登录；局域网绑定下不允许关闭） |
| GET | `/api/backup/export` | 导出配置与观看数据（JSON 下载；`?passwords=1` 才含 WebDAV 密码） |
| POST | `/api/backup/import` | 导入备份（合并语义，返回恢复/跳过汇总） |
| GET/POST | `/api/sources` | 列表（含分类计数、总大小）/ 新增 |
| PUT/DELETE | `/api/sources/{id}` | 修改（密码留空保留）/ 删除（级联清索引） |
| POST | `/api/sources/{id}/probe` | 连通性测试，不落库 |
| POST | `/api/sources/{id}/scan` | 触发扫描（body 可带 `mode=full\|incremental`、`resume=true`） |
| POST | `/api/sources/{id}/scan/pause·resume·cancel` | 扫描控制（取消保留断点，可续扫） |
| GET/DELETE | `/api/sources/{id}/scan-state` | 查询 / 放弃已保存的扫描断点 |
| GET | `/api/tasks`、`/api/tasks/{id}` | 任务列表（每源只留最新）/ 详情含日志 |
| GET | `/api/scan-log` | scan.log 尾部内容 |
| GET | `/api/media` | 分页列表（sources/kinds/folder/q/order/fav/limit/offset；`order=natural` 为自然序） |
| GET | `/api/history` | 观看历史（有进度的媒体，按最近观看时间倒序，支持 sources/limit/offset） |
| GET | `/api/media/{id}` | 详情（播放器信息面板） |
| POST | `/api/media/{id}/fav` | 切换收藏 |
| GET/POST/DELETE | `/api/queue` | 播放队列持久化（只存 id，读取时解析并剔除失效条目） |
| GET/POST | `/api/progress`、`/api/progress-batch` | 观看进度（批量供 sendBeacon） |
| GET | `/api/stream/{id}` | 媒体流（Range，`?dl=1` 下载） |
| GET | `/api/proxy/{id}` | 备用端点（无 Range 全量） |
| GET | `/api/poster/{id}` | TG 同名封面（无则 404） |
| GET | `/api/folder-tree` | 目录树（按源分组，每层带 `count` / `total_size`） |
| GET | `/api/duplicates` | 重复文件组（`name`+`size`，**不算哈希**），含可释放空间 `wasted` |
| GET/POST | `/api/tags` | 标签列表（带媒体数）/ 新建（重名 409） |
| DELETE | `/api/tags/{id}` | 删除标签（**只删标签，不删媒体**） |
| GET/POST | `/api/media/{id}/tags` | 某媒体的标签 / 设置（**全量覆盖**） |
| POST | `/api/media/batch-fav` | 批量收藏 / 取消收藏（幂等） |
| POST | `/api/media/batch-remove` | 批量移除索引（**只删 DB，不删远端文件**） |
| POST | `/api/media/batch-tag` | 批量添加标签（**合并语义**，不解绑已有） |
| GET | `/api/stats/sources` | 按源聚合统计（媒体数分类型 / 大小 / 目录数 / 失败目录数） |
| GET/POST | `/api/settings` | 服务端设置（预留） |

> `/api/media` 除原有参数外，另支持 `folder_prefix`（目录前缀匹配，含子目录）、
> `progress`（`unwatched` / `in_progress` / `finished`）、`tags`（标签 id，`1,2`）。

---

# 编程经验、踩坑与设计文档

这个项目最有传播价值的部分不是功能列表，而是**踩过的坑**。它们已经独立成篇：

- **[docs/lessons.md](./docs/lessons.md)** —— 纯标准库决策、SQLite 并发、Range 流转发、
  扫描任务状态机与竞态、CSS/前端细节坑、测试基建、123 云盘实战全记录……
  每条都是真实发生过的事故，不是想象中的最佳实践。
- **[docs/design-pan123-api.md](./docs/design-pan123-api.md)** —— 「TB 级网盘改用官方 API 扫描」
  的方案设想、风险清单与落地步骤。那是设计文档，不是已实现功能。
- **[docs/ROADMAP.md](./docs/ROADMAP.md)** —— 路线图与取舍记录。
- **[CHANGELOG.md](./CHANGELOG.md)** —— 每个版本改了什么。

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
**[docs/design-pan123-api.md](./docs/design-pan123-api.md)**。在那之前只能靠调参 + 排除目录 + 分根扫描扛，其中「增量扫描 + 把大盘按顶层目录
切成多个数据源分批扫」性价比最高。**注意：该方案尚未实现**，当前版本仍然是纯 WebDAV 扫描。

**Q：自签名证书？** 暂不支持。内网可用 `http://` 地址（会自动识别内网主机名补 http）。

**Q：想精确缩略图？** 当前纯前端截帧（视频第 1 秒），TG 封面模式可让有封面的视频直接用图。要 ffmpeg 级精确缩略图需加后端依赖，暂未引入以保持零依赖。

**Q：怎么清理重复的备份文件？** 媒体库切到「重复」筛选，会按「文件名 + 大小」列出重复组，
每组可「保留 1 移除其余」。**只删本地索引，不动远端文件**，操作前会二次确认。
注意：故意不算文件哈希 —— 算哈希要把每个文件整个拉一遍，TB 级网盘扛不住；
代价是「内容相同但文件名不同」的重复检测不到。

**Q：标签和收藏有什么不同？** 收藏是单开关（有/无）；标签是自定义分类，
一个媒体可以打多个标签（如「剧集」「待看」），还能按标签筛选。
删除标签只删标签本身，不会删媒体。

## 测试

```bash
python tests/run_all.py            # 一键：起隔离服务 → 19 套后端回归 → 自动清理
python tests/run_all.py --env-only # 只起隔离测试环境（调试单个测试时用，Ctrl+C 退出）
python tests/test_compat.py        # 仓库级约束（3.9 语法 / 零依赖 / CI 配置漂移）
python tests/test_folder_tree.py   # 文件夹树（嵌套聚合 / 前缀匹配 / 源过滤）
python tests/test_view_filter.py   # 视图过滤（未看 / 有进度 / 已看完）
python tests/test_batch_ops.py     # 批量操作（批量收藏 / 移除索引）
python tests/test_duplicates.py    # 重复检测（分组 / 大小不同不算重复）
python tests/test_tags.py          # 标签（CRUD / 打标签覆盖 / 级联）
python tests/test_stats_agg.py     # 聚合统计（分类型 / 目录数 / 失败目录）
python tests/test_release.py       # 发布资产（可复现 zip / 校验和 / CHANGELOG 抽取 / Release 流程）
python tests/test_demo.py          # 一键演示的回归（自带假服务，不依赖隔离环境）
node tests/test_browser.js         # 浏览器 60 项（需先起隔离环境）
node tests/test_ui_polish.js
node tests/test_pagination.js
node tests/test_history_tg.js
node tests/audit_ui.js             # 全页面截图审查
```

**CI**（`.github/workflows/ci.yml`）：Ubuntu / Windows / macOS × Python 3.9 / 3.11 / 3.13
跑全量后端回归，外加一个 Chromium job 跑三个自包含 UI 套件。CI 里装的 Playwright 是
**开发依赖**，写进 `package.json` 的 `devDependencies`——运行 WebSua 本身不需要 Node。

**测试与用户数据完全隔离**：所有测试跑在 **8792 端口**（假 WebDAV 在 8898），数据目录是
独立的 `data-test/`——测试里的「清空数据源」「停用源」「删除远端文件」等破坏性操作
只会作用于隔离实例，**永远不碰你正式的 8771 服务和 `data/` 目录**。历史教训：早期
test_e2e 直接打主服务并把所有数据源「清掉旧数据」，把用户刚配好的网盘源删光了。

---

## 发布与版本

版本节奏是**一功能一提交一 tag**：每个功能一个小版本，四条提交（后端 / 前端 / 测试 / 文档）
打完再打 annotated tag，tag 指向该版本最后一个提交。历史见 [CHANGELOG.md](./CHANGELOG.md)。

```bash
python scripts/package.py                 # → dist/WebSua-<版本>.zip + .zip.sha256
python scripts/changelog_section.py v1.21.0   # 抽取该版本说明（Release 正文用）
```

打包的两个刻意设计：

- **可复现**：条目按路径排序 + 固定时间戳，同一份源码打两次 SHA256 完全一致。
  否则「校验和」这东西根本没有意义。
- **不打包本机产物**：`data/`、`data-test/`、`*.db`、`*.log`、`__pycache__`、`node_modules`
  全部排除。发布包里带着别人的媒体库索引是事故，不是功能。

推 `v*` tag 会触发 `.github/workflows/release.yml`：先跑全量回归（**不通过不发布**）→ 打包 →
从 `CHANGELOG.md` 抽当前版本段落当 Release 说明 → 上传 zip 与 `.sha256`。

发布包解压即可用：`python main.py` 正常启动，`python demo.py` 直接演示。
包内保留了 `tests/`——`demo.py` 依赖其中的假 WebDAV 与样例视频，砍掉就演示不了。
