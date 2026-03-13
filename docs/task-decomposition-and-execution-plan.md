# Task Decomposition And Execution Plan

## Background

The current execution model in Novaper can already classify an instruction into `cli`, `desktop`, or `planner`, and the planner can split a complex instruction into multiple subtasks.

However, the current planner output is still too coarse:

- it only provides `title`, `description`, `agentType`, and `dependsOn`
- it does not define the best execution method for each step
- it does not define step-level success criteria
- it can mark a task complete based on a model summary without hard verification

This leads to two common failure modes:

1. the agent chooses an imprecise action path too early, such as coordinate clicking
2. the agent reports completion before the requested outcome is actually verified

## Goal

Replace the current "plan once, execute loosely" model with a rolling execution model:

1. decompose the task into the next few meaningful steps
2. choose the most reliable execution method for the current step
3. verify the outcome of that step before continuing
4. re-plan based on the actual current state

This should become the default strategy for complex desktop and browser tasks.

## Three-Step Execution Loop

Every complex task should follow the same loop.

### Step 1: Confirm Goal And Current State

Before acting, determine what the target actually is and what the current machine state already contains.

Examples:

- for opening an app: determine whether the app is already running, installed as a desktop app, installed as a UWP app, or only available as a web app
- for browser work: determine whether a matching browser window, tab, or logged-in session already exists
- for in-app tasks: determine whether the current window and current page are already at the expected location

Preferred methods:

1. structured system inspection
2. browser/session inspection
3. UI Automation
4. screenshot-based inspection only if the above are insufficient

This step should answer:

- What is the target?
- What is already open?
- What is the next minimal action?
- What evidence will prove the action succeeded?

### Step 2: Execute One Minimal Verifiable Action

Do not perform a long chain of blind actions. Execute one minimal action that can be verified immediately.

Examples:

- open Apple Music
- focus the Apple Music window
- activate the search box
- enter the search query
- click the first playable result

Preferred execution strategy by task type:

- open app:
  - system launch
  - window focus / process tools
  - UI Automation
  - screenshot-based `desktop_actions`
- web page interaction:
  - `browser_*`
  - UI Automation
  - `desktop_actions`
- native app interaction:
  - UI Automation
  - window / process / file tools
  - `desktop_actions`

### Step 3: Verify The Outcome And Re-Plan

After each step, verify whether it actually succeeded.

The next step must be chosen based on the current verified state, not on what the model expected to happen.

Examples:

- "app opened" means:
  - process exists
  - a main window exists
  - the window can be focused
- "search executed" means:
  - the query is no longer in an editable box only
  - results or a new page state appear
- "music is playing" means:
  - the play button changed to pause, or
  - a now-playing area appeared, or
  - playback progress changed

If verification fails:

- do not report completion
- record the failed attempt
- generate the next best step based on current state

## Best Method Selection Matrix

### Open App

Use the following preference order:

1. system launch
2. process / window validation
3. UI Automation
4. visual fallback

System launch should support:

- direct executable path
- Start Menu shortcuts
- registry `App Paths`
- UWP `shell:AppsFolder`
- protocol launch when applicable

### Browser Tasks

Use the following preference order:

1. `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`
2. browser tab and window inspection
3. UI Automation
4. visual fallback

When any browser result reports visual fallback, the system should stop relying on DOM selectors and switch into screenshot-driven execution explicitly.

### Native App Tasks

Use the following preference order:

1. UI Automation
2. deterministic window and process tools
3. visual fallback

For custom-rendered apps or unreliable UIA trees, the system should quickly downgrade rather than repeating the same failing UIA path.

## Required Runtime Changes

### 1. Extend Planner Output

`packages/runner-core/src/taskPlanner.ts`

Add fields to each plan item:

- `preferredMethods`
- `successCriteria`
- `fallbackPolicy`
- `replanHint`
- `atomic`

Example shape:

```ts
interface TaskPlanItem {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "waiting_input";
  agentType: "cli" | "desktop";
  dependsOn?: string[];
  preferredMethods?: Array<"system_launch" | "browser_dom" | "uia" | "window_tools" | "vision">;
  successCriteria?: string[];
  fallbackPolicy?: string[];
  replanHint?: string;
  atomic?: boolean;
  summary?: string;
}
```

The planner should still return a short plan, but each step should now include the intended control path and acceptance rule.

### 2. Add A Step Strategy Layer

`apps/runner/src/server.ts`

Current planner execution sends each desktop task directly to `driveDesktopAgent`.

Instead, add a step strategy phase:

1. pick the next executable task
2. build a current-step execution strategy
3. instruct the sub-agent to use the preferred method first
4. require explicit success evidence before marking the task complete
5. if the evidence is missing, keep the task open and re-plan

This keeps the current planner loop, but makes each subtask execution far more controlled.

### 3. Add System-Level App Opening Tools

`packages/runner-core/src/toolRegistry.ts`

Add high-priority tools for software launch:

- `resolve_application`
- `open_application`
- `wait_for_process`
- `wait_for_window`
- `verify_window_state`

Suggested behavior:

- `resolve_application`
  - map a user-facing app name to launch candidates
- `open_application`
  - launch via the highest-confidence method
- `wait_for_process`
  - ensure the target process exists
- `wait_for_window`
  - ensure a usable foreground-capable window appears
- `verify_window_state`
  - confirm title, process, focus, and visibility

These tools should be preferred over clicking desktop icons or taskbar buttons.

### 4. Add Hard Step Validation

`packages/runner-core/src/desktopAgent.ts`

The desktop agent should not allow a task to complete purely because the model summary sounds plausible.

Completion should require at least one verification signal that matches the current step's `successCriteria`.

If verification is missing:

- return a partial result
- mark the step as still in progress or failed
- force the planner loop to decide the next move

## Example: "Open Apple Music And Play Jay Chou"

The intended rolling plan should look like this.

### Step 1

Goal:
- resolve what "Apple Music" refers to on the current machine

Preferred method:
- system inspection

Success criteria:
- a launch target is identified, or
- no valid local target exists and web fallback is required

### Step 2

Goal:
- open and focus Apple Music

Preferred method:
- `open_application`
- `wait_for_window`
- `verify_window_state`

Success criteria:
- process exists
- window exists
- target window is focused or focusable

### Step 3

Goal:
- search for Jay Chou and start playback

Preferred method:
- UI Automation first
- visual fallback only if UIA is unreliable

Success criteria:
- search results are visible
- a track is selected or playing
- playback state is confirmed

If playback is not confirmed, the next step should become:

- select a specific result
- click play
- verify playback again

The agent should not report completion after merely opening the app or typing a query.

## Implementation Order

Recommended order:

1. add hard success validation first
2. add system-level app opening tools
3. extend planner output with execution strategy fields
4. add rolling re-planning based on verified current state

This order reduces false completion immediately, then improves precision, then improves planning quality.

## Expected Benefits

- app opening becomes deterministic instead of coordinate-dependent
- browser tasks stay in DOM mode longer and downgrade more cleanly
- native app tasks avoid repeated blind clicks
- the system no longer claims success without evidence
- long tasks become easier to recover because each step is re-planned from current state
