# Novaper HTTP API 参考

## 基础信息

- 默认地址：`http://127.0.0.1:3333`
- 数据格式：`application/json`
- 实时事件：SSE

## 系统接口

### `GET /api/system/health`

用途：
- 检查服务、sidecar、auth、proxy 是否正常

返回要点：

```json
{
  "ok": true,
  "version": "0.1.0",
  "machine": {},
  "scenarios": 1,
  "auth": {},
  "proxy": {
    "enabled": true,
    "url": "http://127.0.0.1:7890",
    "source": "NOVAPER_PROXY_URL"
  }
}
```

## 认证接口

### `GET /api/auth/status`

用途：
- 查看当前默认 provider 与各认证状态

### `POST /api/auth/codex/login`

用途：
- 发起 Codex OAuth 登录

返回：

```json
{
  "authorizeUrl": "https://auth.openai.com/oauth/authorize?...",
  "startedAt": "2026-03-09T08:28:11.936Z"
}
```

### `POST /api/auth/codex/logout`

用途：
- 清除本地 Codex OAuth 凭据

## Live Session 接口

### `POST /api/live-sessions`

用途：
- 创建实时桌面会话

请求示例：

```json
{
  "model": "gpt-5.4",
  "authProvider": "codex-oauth"
}
```

### `POST /api/live-sessions/:id/observe`

用途：
- 主动刷新当前桌面截图和窗口状态

### `POST /api/live-sessions/:id/commands`

用途：
- 向某个实时会话发送一条新指令

请求示例：

```json
{
  "text": "打开微信并切到最近的聊天",
  "authProvider": "codex-oauth"
}
```

### `POST /api/live-sessions/:id/stop`

用途：
- 请求停止当前动作链

### `GET /api/live-sessions/:id/events`

用途：
- 订阅实时事件流

事件类型包括：
- `status`
- `log`
- `message`
- `tool_call`
- `tool_result`
- `screenshot`
- `error`

## Run 接口

### `GET /api/scenarios`

用途：
- 列出可运行场景

### `POST /api/runs`

用途：
- 发起一个场景 run

请求示例：

```json
{
  "scenarioId": "notepad-hello",
  "authProvider": "api-key",
  "input": {}
}
```

### `GET /api/runs`

用途：
- 列出历史 run

### `GET /api/runs/:id`

用途：
- 获取某个 run 的详情和事件

### `POST /api/runs/:id/stop`

用途：
- 停止 run

### `POST /api/runs/:id/retry`

用途：
- 基于历史 run 重试

### `GET /api/runs/:id/events`

用途：
- 订阅 run 的 SSE 事件流

### `GET /api/runs/:id/replay`

用途：
- 下载 replay zip

## SSE 使用说明

客户端收到的每条事件都包含：
- `id`
- `at`
- `type`
- `level`
- `message`
- `payload`

其中最关键的是：
- `tool_call`：模型请求了哪个工具及其参数
- `tool_result`：工具返回了什么
- `screenshot`：产生了新的桌面截图
- `error`：执行中断原因

## 兼容性说明

- `api-key` 路径更接近公开 OpenAI API。
- `codex-oauth` 路径为自定义兼容层，不要假设它与官方 SDK 100% 等价。
