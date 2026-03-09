# Novaper 桌面自动化策略

## 自动化层级

Novaper 不是单一手段操作桌面，而是分成四层：

1. UI Automation 与确定性工具
2. 进程、窗口、文件级工具
3. `desktop_actions` 视觉坐标动作
4. 官方 `computer` tool

实际执行时遵循“先稳后泛化”的原则。

## 第一层：UIA 与确定性工具

这层适合标准 Windows 控件和可稳定枚举的界面。

典型能力：
- `uia_find`
- `uia_invoke`
- `uia_set_value`
- `focus_window`
- `list_windows`
- `start_process`
- `terminate_process`

优点：
- 快
- 可解释
- 不容易误点

缺点：
- 微信、WPS 等第三方应用不一定稳定暴露控件
- 标题、控件名、层级一变就可能找不到元素

## 第二层：视觉 fallback

当模型判断 UIA 不可靠时，会基于当前截图推理坐标，并调用 `desktop_actions`。

当前支持的动作包括：
- `click`
- `double_click`
- `move`
- `drag`
- `scroll`
- `type`
- `keypress`
- `wait`
- `screenshot`

这层是 Novaper 在 Codex OAuth 下的关键能力，因为它不依赖官方 `computer` tool。

## 第三层：官方 `computer` tool

这层主要保留给 API key 路径。

说明：
- 公开 OpenAI API 文档支持这条能力。
- Codex OAuth backend 当前不保证兼容。
- 因此 Novaper 在 `codex-oauth` 模式下默认不依赖它。

## 什么时候应该强制视觉，不要 UIA

下面这些情况，建议直接走视觉：
- 微信联系人列表、聊天列表、搜索框
- WPS 自定义工具栏、文件菜单、导出面板
- Electron 应用的自绘控件
- 多语言、多主题或高 DPI 下标题名不稳定的控件

## 典型失败原因

### `UI element not found.`

这是最常见的 UIA 失败。

含义：
- sidecar 按 selector 去查控件
- 当前窗口里没有匹配项
- 所以在真正点击或输入前就中断了

常见原因：
- 当前焦点窗口不对
- 窗口标题不一致
- 控件名和预期不同
- 目标应用没有把控件暴露为标准 UIA `Edit` / `Button`

## 建议的操作策略

### 微信

- 搜索联系人、切换对话优先走视觉。
- 输入框如果能稳定聚焦，可以用视觉点击后 `type`。

### WPS / Office 类应用

- 菜单和工具栏优先视觉。
- 打开/另存为等系统原生文件对话框可以再尝试 UIA。
- 如果是 WPS 自己封装的对话框，不要假设存在标准 `Edit`。

### 资源管理器 / 系统设置

- 优先 UIA。
- 如果存在动画或面板切换，动作后加 `wait` 与截图刷新。

## 调试建议

- 先看控制台里的 `tool_call` 和 `tool_result`。
- 如果连续出现空的 `uia_find` 结果，就不要继续硬试 UIA。
- 立刻切到视觉模式，减少错误链路。
- 对重要流程保留 replay，方便复盘。
