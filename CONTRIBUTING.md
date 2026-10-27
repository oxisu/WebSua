# 贡献指南

感谢你对 WebSua 的关注！这个项目遵循「**一功能一提交一 tag**」的细粒度版本控制，
提交信息一律用**中文**。

## 开发环境

- Python 3.9+（纯标准库，无需 pip install）
- Node.js（仅测试用，装 Playwright：`npm install`）
- 推荐 VS Code 或 PyCharm

```bash
python main.py          # 启动开发服务
python demo.py          # 一键演示（不需要网盘账号）
python tests/run_all.py # 全量回归（13 套后端测试）
```

## 代码规范

- **后端**：纯标准库（`http.server` / `sqlite3` / `threading` 等），不引第三方依赖
- **前端**：原生 ES Module + CSS，无框架、无构建步骤
- **测试**：每个新功能配测试，全量回归必须通过
- **命名**：后端 PEP 8，前端 camelCase，CSS kebab-case + `cvp-` 播放器前缀
- **注释**：解释「为什么」而不是「做了什么」

## 提交规范

格式：`<type>(<scope>): <描述>`

- `feat` / `fix` / `docs` / `test` / `ci` / `chore` / `refactor`
- scope 可选：`backend` / `frontend` / `test` / `cli` / `release` 等
- 描述用中文，简洁明了

示例：
```
feat(backend): 扫描器支持目录排除
fix(frontend): 视频流滚动到底时不重复加载
docs: 变更日志与路线图 v1.14.0
```

## 测试要求

| 改动范围 | 需要跑的测试 |
| --- | --- |
| 后端（backend/） | `python tests/run_all.py`（13 套全量） |
| 前端（frontend/） | `node tests/test_browser.js` + `node tests/test_ui_polish.js` |
| 测试 / CI | `python tests/test_compat.py` + `python tests/test_release.py` |
| 文档 | `python tests/test_compat.py`（仓库约束） |

**测试与用户数据完全隔离**：所有测试跑在 `data-test/` + 8792 端口，
不碰你的 `data/` 目录和正式服务。

## 提交前自查

1. `python tests/run_all.py` 全部通过
2. 没有引入第三方运行时依赖
3. 没有硬编码密钥 / 密码 / 本机路径
4. CHANGELOG.md 有对应记录（如适用）

## 报告 Bug

用 [Bug 报告模板](./.github/ISSUE_TEMPLATE/bug_report.md)，
附上环境信息与复现步骤。**`data/scan.log` 里的播放失败 / 扫描错误片段**最有价值。

## 安全问题

请看 [SECURITY.md](./SECURITY.md)，**不要**公开提 Issue。
