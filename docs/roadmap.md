# Roadmap

## Current Integration State

Novaper now has the core shape needed for a Milady-style local agent control plane:

- runtime capability snapshots exposed through the runner
- skill and capability context injected into planner, CLI, and desktop agent prompts
- server-side workflow persistence
- server-side scheduled task persistence and local cron execution
- runner-side device and device-group state shared by chat, device management, and scheduled tasks

## Next Development Plan

### 1. Real Device Transport

Replace mock device plumbing with real transports:

- ADB-backed USB and WiFi device discovery
- real screenshot, tap, swipe, text input, and app control on connected devices
- remote bridge adapters for non-local devices

This is the next highest-leverage step because it turns the current control plane into real device execution instead of simulated state.

### 2. Multi-Device Task Dispatch

Make scheduled tasks execute against the selected devices or device groups instead of always running on the local runner:

- resolve task targets from `device_serialnos` or `device_group_id`
- create one execution unit per target device
- track per-device success, failure, and partial completion
- persist target-level run history for replay and diagnosis

### 3. MCP as Callable Tools

The runner already surfaces MCP presence in the capability model. The next step is to make those servers callable during execution:

- register MCP tools into the live tool surface
- inject tool schemas into planner and agent routing
- add per-tool permission and timeout controls

### 4. Automation Hardening

Strengthen the background automation path:

- task concurrency policies
- retry and backoff behavior
- task logs and artifact links in the UI
- guardrails for destructive actions

### 5. Verification and Regression Coverage

Increase confidence before broader rollout:

- tests for capability snapshot generation
- tests for workflow and scheduled-task APIs
- tests for device-group target resolution
- end-to-end checks for the operator UI against runner APIs
