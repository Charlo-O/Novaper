# Product Overview

## Positioning

Novaper is a local Windows AI computer operator. It is not only a chat UI, and it is not only a script runner. The system is built to let a model observe the current desktop, decide on the right control path, execute actions, and leave a replayable record.

## Core Product Surfaces

### Live Desktop Operator

The operator creates a live session, observes the current desktop, sends one instruction at a time, and watches the agent stream back screenshots, tool calls, tool results, summaries, and errors.

### Scenario Runner

The runner executes predefined scenarios from `scenarios/`, persists structured events, and produces replay artifacts for review and regression work.

## Execution Modes

Novaper routes work into three modes:

- `desktop`: GUI-heavy work on the local machine
- `cli`: shell or file-oriented work
- `planner`: multi-step instructions that need decomposition before execution

The router lives in `packages/runner-core/src/instructionClassifier.ts`, and planning lives in `packages/runner-core/src/taskPlanner.ts`.

## Automation Strategy

Novaper uses different control paths depending on the target surface.

For websites in Chromium browsers:
- `browser_*` tools backed by `puppeteer-core`
- DOM-aware navigation, tab control, element inspection, typing, keyboard shortcuts, scrolling, and text extraction

For native Windows apps:
- UI Automation and deterministic tools first
- process, file, and window management next
- screenshot-driven `desktop_actions` as the visual fallback

## State and Persistence

Novaper persists runtime state under `data/`:

- `data/live-sessions`: live session metadata, events, screenshots
- `data/runs`: scenario runs and replay assets
- `data/logs`: server console capture and JSONL logs
- `data/memory`: app profiles, long-term memory, session snapshots
- `data/auth`: local auth state for Codex OAuth

## Why This Product Shape

The design goal is pragmatic reliability:

- use structured tools where possible
- keep a vision fallback for hostile or custom desktop apps
- preserve every important action as events and artifacts
- support both official API auth and Codex OAuth without rewriting the rest of the stack

## Current Boundaries

- local-machine, Windows-first product
- no RBAC or multi-user isolation model
- no background fleet scheduler
- no bundled browser; Chromium automation uses the operator's installed Chrome, Edge, or Brave
