# Novaper 安装、启动与认证

## 环境要求

- Windows 桌面环境
- Node.js 与 npm
- PowerShell
- 可交互的本地桌面会话

建议在真实桌面登录状态下运行，不要在锁屏或无人值守会话里启动。

## 安装

```powershell
npm install
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 官方 OpenAI API key | 无 |
| `OPENAI_MODEL` | 默认模型 | `gpt-5.4` |
| `PORT` | 服务端口 | `3333` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `NOVAPER_PROXY_URL` | Novaper 显式代理地址 | 无 |
| `WINAI_PROXY_URL` | 旧代理变量名，仍兼容 | 无 |
| `HTTPS_PROXY` | 标准 HTTPS 代理 | 无 |
| `HTTP_PROXY` | 标准 HTTP 代理 | 无 |
| `ALL_PROXY` | 通用代理 | 无 |

## 启动

```powershell
npm start
```

启动成功后访问：

[http://127.0.0.1:3333](http://127.0.0.1:3333)

## 认证方式

### 方式一：OpenAI API Key

适合：
- 你已经有 OpenAI API 使用权限
- 你希望保留官方 SDK 路线
- 你要优先使用官方 `computer` tool

配置方式：

```powershell
$env:OPENAI_API_KEY="sk-..."
npm start
```

### 方式二：Codex OAuth

适合：
- 你想使用 ChatGPT Plus/Pro 中的 Codex 登录态
- 你不想在本地放 API key
- 你接受当前以 Novaper 自定义桌面工具为主

流程：

1. 启动 Novaper。
2. 打开控制台并点击 `Login Codex`。
3. 浏览器完成 OpenAI 授权。
4. OpenAI 回调到 `http://localhost:1455/auth/callback`。
5. 刷新后的凭据落盘到 `data/auth/codex-oauth.json`。

注意：
- `1455` 端口冲突会直接导致登录失败。
- 这条路径仍然需要代理可达 OpenAI/Codex 服务。

## 代理规则

Novaper 启动时会强制为进程级网络流量配置代理，优先级如下：

1. `NOVAPER_PROXY_URL`
2. `WINAI_PROXY_URL`
3. `HTTPS_PROXY`
4. `HTTP_PROXY`
5. `ALL_PROXY`

如果你的环境不走代理就会 `403`，应优先设置 `NOVAPER_PROXY_URL`，避免依赖其他工具的隐式代理识别。

## 健康检查

接口：

`GET /api/system/health`

重点字段：
- `ok`
- `machine`
- `auth`
- `proxy`

这对排查下面几类问题很有用：
- sidecar 是否正常
- 当前默认 provider 是什么
- 代理有没有生效

## 常见故障

### `OPENAI_API_KEY is not configured`

原因：
- 你选择了 `api-key` provider，但环境里没有 `OPENAI_API_KEY`

处理：
- 切到 `Codex OAuth`
- 或设置 `OPENAI_API_KEY` 后重启

### `Codex OAuth is not authenticated`

原因：
- 还没有完成登录
- 或凭据已失效

处理：
- 控制台重新点击 `Login Codex`
- 检查代理和 `1455` 端口

### 403 / 网络被拒

原因：
- 代理没生效
- 代理地址填错
- 当前网络无法直连 OpenAI

处理：
- 优先设置 `NOVAPER_PROXY_URL`
- 查看 `/api/system/health` 中的 `proxy.enabled`、`proxy.source` 和 `proxy.url`

### 400 / Codex backend 参数错误

Novaper 已经针对 Codex backend 做了兼容封装。如果仍然遇到 400，优先检查：
- 当前 transport 是否被改坏
- 是否给 Codex 路径传入了官方 `computer` tool
- 是否漏了 `instructions` 或 `stream`
