# Desktop and Browser Automation

## Control Hierarchy

Novaper does not use one universal control path. It chooses the narrowest reliable tool first.

Current preference order:

1. `browser_*` tools for Chromium web pages
2. UI Automation and deterministic desktop tools
3. process, file, and window tools
4. `desktop_actions`
5. official `computer` tool when available from the provider

## Browser Automation

The new browser path is backed by `packages/browser-runtime/src/browserSessionManager.ts`.

Available browser tools:

- `browser_open`
- `browser_tabs`
- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_press_keys`
- `browser_wait_for`
- `browser_scroll`
- `browser_read`

Use this path when:

- the target is a web page in Chrome, Edge, or Brave
- you need DOM-aware inspection instead of screenshot guessing
- you need stable form filling, tab handling, or keyboard shortcuts such as `Ctrl+L`

Recommended browser workflow:

1. `browser_open` or `browser_navigate`
2. `browser_snapshot`
3. act with `browser_click`, `browser_type`, or `browser_press_keys`
4. verify with `browser_snapshot` or `browser_read`

## Deterministic Desktop Tools

Use these first for native Windows apps when they are reliable:

- `list_windows`
- `focus_window`
- `launch_process`
- `kill_process`
- `check_file`
- `move_file`
- `rename_file`
- `uia_find`
- `uia_invoke`
- `uia_set_value`
- `detect_elements`

Why this path is preferred:

- more deterministic than vision clicks
- easier to debug
- less sensitive to screen scale and layout drift

## `desktop_actions`

`desktop_actions` is the visual fallback when structured desktop access is weak or unavailable.

Supported actions:

- `click`
- `double_click`
- `move`
- `drag`
- `scroll`
- `type`
- `keypress`
- `wait`
- `screenshot`

Use this path when:

- UIA cannot find the element
- the app is custom-drawn or Electron/Qt-heavy
- the target is only visually identifiable

## App-Specific Guidance

### Chromium Browsers

Preferred mode:

- `browser_*` tools first

Fallbacks:

- `desktop_actions` only if the browser page is blocked by modal UI outside the page surface

### File Explorer and Standard Windows Dialogs

Preferred mode:

- UI Automation

Fallbacks:

- `desktop_actions` if animations or custom surfaces break the normal path

### WeChat and QQ

Preferred mode:

- vision-first desktop control

Reason:

- custom UI frameworks often expose unstable or incomplete UIA trees

### WPS Office

Preferred mode:

- mixed strategy

Reason:

- some dialogs behave like standard Windows UI
- ribbon and app chrome often require visual fallback

## Debugging Strategy

If a task fails:

1. inspect `tool_call` and `tool_result` events first
2. if browser work failed, verify the last `browser_snapshot`
3. if UIA returns nothing repeatedly, stop forcing UIA and switch to fallback
4. if a page changed, re-snapshot before issuing more DOM actions
5. keep the session artifacts for replay and postmortem

## Practical Rule

For websites, stop thinking in desktop pixels unless you have to.

For native Windows apps, stop forcing DOM-style behavior where there is no DOM.
