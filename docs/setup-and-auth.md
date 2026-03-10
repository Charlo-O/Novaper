# Setup and Auth

## Prerequisites

- Windows desktop session with an interactive logged-in user
- Node.js 20+
- PowerShell
- A reachable path to OpenAI or the Codex backend, direct or through proxy
- An installed Chromium browser if you want DOM-aware browser automation

Supported browser targets:

- Google Chrome
- Microsoft Edge
- Brave

## Installation

```powershell
npm install
```

## Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Official OpenAI API path | unset |
| `OPENAI_MODEL` | Default model for runs and live sessions | `gpt-5.4` |
| `PORT` | Runner port | `3333` |
| `HOST` | Bind address | `127.0.0.1` |
| `NOVAPER_PROXY_URL` | Explicit Novaper proxy | unset |
| `HTTPS_PROXY` | HTTPS proxy fallback | unset |
| `HTTP_PROXY` | HTTP proxy fallback | unset |
| `ALL_PROXY` | Generic proxy fallback | unset |

## Start the Runner

```powershell
npm start
```

Open:

[http://127.0.0.1:3333](http://127.0.0.1:3333)

## Auth Modes

### OpenAI API Key

Use this when:

- you have a usable OpenAI API key
- you want the official SDK path
- you may want provider-native computer-tool support where available

PowerShell example:

```powershell
$env:OPENAI_API_KEY = "sk-..."
npm start
```

### Codex OAuth

Use this when:

- you want to authenticate through local ChatGPT Codex login
- you do not want to store `OPENAI_API_KEY`
- you are fine using Novaper's own desktop and browser tools

Flow:

1. Start Novaper.
2. Open the control panel.
3. Trigger `Login Codex`.
4. Complete browser authorization.
5. Novaper stores credentials at `data/auth/codex-oauth.json`.

Callback URL:

- `http://localhost:1455/auth/callback`

Operational notes:

- port `1455` must be free
- Codex OAuth is handled by Novaper's custom transport
- the Codex path does not assume official `computer` tool support

## Proxy Resolution

The runner resolves proxy configuration in this order:

1. `NOVAPER_PROXY_URL`
2. `HTTPS_PROXY`
3. `HTTP_PROXY`
4. `ALL_PROXY`

Use `NOVAPER_PROXY_URL` when you want predictable Novaper-only behavior instead of inheriting generic system proxy state.

## Health Check

Endpoint:

- `GET /api/system/health`

Useful fields:

- `ok`
- `machine`
- `auth`
- `proxy`

This is the first thing to check when:

- auth is failing
- sidecar connectivity is broken
- proxy routing is unclear

## Common Failures

### `OPENAI_API_KEY is not configured`

Cause:

- you selected the `api-key` path without setting `OPENAI_API_KEY`

Fix:

- set `OPENAI_API_KEY`
- or switch to `Codex OAuth`

### `Codex OAuth is not authenticated`

Cause:

- the OAuth flow has not been completed
- or the stored credential has expired

Fix:

- run `Login Codex` again from the control panel
- verify that port `1455` is available
- verify proxy reachability if the login page cannot complete

### `403` or backend reachability issues

Cause:

- proxy not set or misconfigured
- local network cannot reach the required backend

Fix:

- set `NOVAPER_PROXY_URL`
- confirm the value through `/api/system/health`

### Browser automation cannot start

Cause:

- no supported Chromium browser is installed locally

Fix:

- install Chrome, Edge, or Brave
- verify one of them exists at a normal Windows install path

### Desktop actions fail while the machine looks healthy

Cause:

- Novaper is running without an interactive unlocked desktop session

Fix:

- run it in a real logged-in Windows session
- avoid locked screen, disconnected session, or non-interactive service contexts
