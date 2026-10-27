# 安全政策

## 报告漏洞

如果你发现了安全漏洞，**请勿公开提交 Issue**。

请通过 GitHub Security Advisories 私下报告：
→ [Report a vulnerability](https://github.com/oxisu/WebSua/security/advisories/new)

或者发邮件到项目维护者（见 GitHub profile）。

我会在 **72 小时内**回复，修复后会致谢（如果你愿意署名）。

## 安全设计原则

WebSua 在以下方面做了安全默认值设计：

### 网络暴露

| 场景 | 行为 |
| --- | --- |
| `--host 127.0.0.1`（默认） | 仅本机访问，不需要密码 |
| `--host 0.0.0.0` + 无密码 | **拒绝启动**（不是警告后裸奔） |
| `--host 0.0.0.0` + `--password` | 启动，强制门禁 |

### 凭据存储

- 访问密码：**pbkdf2-hmac-sha256 + 随机 salt**，仅存摘要，不明文入库
- WebDAV 密码：存 SQLite（本地文件），导出备份时**默认脱敏**（只记 `has_password`）
- 令牌：改密码会**吊销全部已签发令牌**

### API 鉴权

- 开启门禁后：`/api/*` **全部受保护**（含媒体流 / 封面 / 字幕）
- 免鉴权端点仅：`/api/auth/login`、`/api/auth/status`、`/api/health`
- 静态资源正常下发（否则登录界面无法渲染）

### 暴力破解防护

- 登录失败限流：连续 5 次锁定 60 秒

### 数据隔离

- 测试数据目录 `data-test/`，端口 8792 / 8898，与用户数据完全隔离
- `demo.py` 演示数据目录 `data-demo/`，有护栏防止写入 `data/`

## 已知限制

- **单用户门禁**，不做多用户 / RBAC
- **不支持自签名证书**（内网可用 `http://`）
- **密码不加密存储**（WebDAV 密码明文存 SQLite），数据库被读取即可获取
  —— 这是「零依赖」的取舍；如需加密存储需要引入 `cryptography` 依赖
- 无 HTTPS（依赖反向代理如 nginx 提供 TLS）
