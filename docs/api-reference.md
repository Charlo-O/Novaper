# API Reference

Base URL:

- `http://127.0.0.1:3333`

Formats:

- request and response payloads use JSON unless noted
- streaming endpoints use Server-Sent Events

## System

### `GET /api/system/health`

Returns machine, auth, scenario count, and proxy health.

## Auth

### `GET /api/auth/status`

Returns the current auth status for the configured providers.

### `POST /api/auth/codex/login`

Starts the local Codex OAuth flow.

### `POST /api/auth/codex/logout`

Clears stored Codex OAuth credentials.

## Scenarios and Runs

### `GET /api/scenarios`

Lists available scenarios from `scenarios/`.

### `GET /api/runs`

Lists historical runs.

### `GET /api/runs/:id`

Returns a single run record and its events.

### `POST /api/runs`

Starts a new scenario run.

Request body:

```json
{
  "scenarioId": "notepad-hello",
  "authProvider": "api-key",
  "model": "gpt-5.4",
  "input": {}
}
```

### `POST /api/runs/:id/stop`

Requests stop for a running scenario.

### `POST /api/runs/:id/retry`

Retries an existing run with the original scenario and input.

### `GET /api/runs/:id/events`

SSE stream of run events.

### `GET /api/runs/:id/replay`

Downloads the replay archive for a run.

## Live Sessions

### `GET /api/live-sessions`

Lists live sessions.

### `POST /api/live-sessions`

Creates a live session.

Request body:

```json
{
  "model": "gpt-5.4",
  "authProvider": "codex-oauth"
}
```

### `GET /api/live-sessions/:id`

Returns the live session record and full event history.

### `GET /api/live-sessions/:id/events`

SSE stream of live session events.

### `POST /api/live-sessions/:id/observe`

Captures the current desktop state.

Response highlights:

- updated session
- machine heartbeat
- visible windows
- screenshot URL, width, and height

### `POST /api/live-sessions/:id/commands`

Submits one live instruction to the agent.

Request body:

```json
{
  "instruction": "Open Chrome and search for the latest OpenAI API pricing.",
  "authProvider": "api-key",
  "model": "gpt-5.4"
}
```

Behavior:

- rejects when another instruction is already executing
- rejects when the session is waiting for confirmation
- routes the instruction to `desktop`, `cli`, or `planner`

### `POST /api/live-sessions/:id/confirm`

Resolves a pending confirmation.

Request body:

```json
{
  "choice": "confirmed"
}
```

### `POST /api/live-sessions/:id/stop`

Requests stop for the current live execution.

### `GET /api/live-sessions/:id/screen-stream`

SSE frame stream for near-live screenshots.

Payload shape:

```json
{
  "timestamp": 1741580000000,
  "width": 1920,
  "height": 1080,
  "image": "<base64>"
}
```

## Logs

### `GET /api/logs/files`

Lists available log files from `data/logs/`.

### `GET /api/logs/files/:filename`

Returns one log file as plain text.

### `GET /api/logs/stream`

SSE stream of live log entries with catch-up.

## Memory

### `GET /api/memory/global`

Returns global memory entries.

### `GET /api/memory/apps`

Returns app profiles.

### `GET /api/memory/apps/:name`

Returns one app profile by name.

### `POST /api/memory`

Creates a memory entry.

Request body:

```json
{
  "content": "User prefers Chrome over Edge for browser tasks.",
  "category": "preference",
  "appContext": "Chrome",
  "tags": ["browser", "preference"],
  "confidence": 0.9
}
```

### `DELETE /api/memory/:id`

Deletes one memory entry by id.

## Unified History

### `GET /api/history`

Returns a merged list of live sessions and runs.

Query params:

- `limit`
- `offset`

### `GET /api/history/:id`

Returns one history record. The record may be either a live session or a run.

### `DELETE /api/history/:id`

Deletes either a live session or a run.

## Event Types

Common SSE event types:

- `status`
- `log`
- `message`
- `tool_call`
- `tool_result`
- `computer_action`
- `screenshot`
- `error`
- `agent_route`

Important interpretation:

- `tool_call`: the agent asked to invoke a tool
- `tool_result`: the tool returned successfully or with structured failure detail
- `computer_action`: low-level computer-tool action request
- `agent_route`: whether the instruction was routed to `desktop`, `cli`, or `planner`

## Notes

- `api-key` and `codex-oauth` do not have identical transport behavior
- browser automation is exposed through internal tools, not direct HTTP endpoints
- live-session commands must use `instruction`, not `text`
