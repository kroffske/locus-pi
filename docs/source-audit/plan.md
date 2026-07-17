# Source audit: plan

Decision: `plan` is default-loaded and owns behavioral `/plan`/`/mode` runtime plus the active local goal runtime. `/review` and `/todos` are separate prompt shelves; OMP goal-tool parity is partial and documented below.

`plan` owns three distinct groups of surfaces:

- behavioral `/plan` and `/mode` runtime, including an explicitly enabled optional `Shift+Tab` shortcut, mode cues, authored plans, and exit handoff,
- `/review` and `/todos` for explicit prompt shelves,
- local goal runtime:
  - `/goal <objective>` for lifecycle state,
  - `/goal show|budget|pause|resume|complete|drop` for runtime control,
  - `/goal prompt` and `/goal-ai` for prompt-writing surfaces,
  - model-callable `goal` tool,
  - `before_agent_start` context injection for active, paused, or budget-limited goals only.

## OMP source evidence used

This implementation uses OMP source-backed evidence for shape and parity assessment, but does not declare copied code.

OMP source evidence:

- `oh-my-pi:packages/coding-agent/src/goals/runtime.ts`
- `oh-my-pi:packages/coding-agent/src/goals/state.ts`
- `oh-my-pi:packages/coding-agent/src/goals/tools/goal-tool.ts`
- `oh-my-pi:packages/coding-agent/src/modes/interactive-mode.ts`
- `oh-my-pi:packages/coding-agent/src/session/agent-session.ts`
- `oh-my-pi:packages/coding-agent/src/tools/index.ts`
- `oh-my-pi:packages/coding-agent/src/config/settings-schema.ts`

License note: OMP checkout is MIT-licensed. The listed files were used as source evidence only; this extension is not a copied implementation and remains a Locus-owned adaptation.

## Current behavior and review basis

- `/plan` is behavioral prompt injection: `before_agent_start` appends planning framing while plan mode is active; it does not enforce read-only execution.
- `session_start` restores the shared status route and input-editor border cues. `/mode` cycles `default ⇄ plan` immediately. The extension does not register `Shift+Tab` at default startup; after `/mode bind-shift-tab` frees Pi's reserved chord and reload/restart applies the binding, it registers the optional shortcut.
- Commands and throwaway scripts remain allowed in plan mode. There is no `tool_call` hook and no permission guard owned by this extension.
- Authored plan artifacts persist to `~/.pi/locus-pi/<project-slug>/plans/<plan-slug>.md`. Leaving plan mode in headless mode or without a composed artifact degrades to plain exit; with an artifact and UI it offers execute-in-context, execute-after-reset, tweak-then-execute, or keep-planning handoff. An unavailable replacement-session host blocks plan authoring and writes no plan artifact.
- `/goal <objective>` and `/goal set <objective>` persist state to `.locus/runtime/goal/state.json`.
- `/goal show|pause|resume|complete|drop|budget` mutate local state.
- model-callable `goal` supports `create/get/complete/resume/drop`.
- `before_agent_start` appends `<goal_context>...</goal_context>` to the session system prompt for active, paused, or budget-limited states; complete and dropped goals do not inject context.
- `/review`, `/todos`, `/goal prompt`, and `/goal-ai` are explicitly prompt-writing surfaces and do not execute plan/goal state transitions.
- Bare `/plan` and `/goal-ai` use Locus-owned typed input dialogs. Escape is a no-write/no-model-turn result; submit reuses the existing explicit-argument path exactly once.
- `/mode`, plan entry/exit, and goal-ai draft receipts use the shared typed operator blocks. Active plan mode contributes one bounded `plan.mode` route label to `status:locus` instead of owning a separate status row.
- `/plan list|help|open` static paths are local typed `VIEW`, `WARN`, and bounded `CHANGE` surfaces; they do not claim OMP rendering parity.
- `/goal` runtime state uses typed `VIEW/CHANGE/WARN/ERROR` cards. `/review`, `/todos`, and `/goal prompt` are separate summary-first prompt shelves: bare inspection omits body, `show/read` opens it, and `set <prompt>` preserves literal reserved verbs without changing storage.
- Cancelling the plan-exit selector or tweak dialog keeps plan mode and queues no execution message.

`OMP references are used as parity evidence, not as a runtime dependency.`

## Unsupported / unchecked gaps

- No OMP-native footer parity.
- No OMP-style autonomous continuation behavior.
- Exact token usage accounting is tracked locally but not proven equivalent to OMP accounting internals yet.
- Hidden-tool parity is incomplete when the Pi extension API surface cannot prove equivalent behavior end to end.
- The local `_shared/pi-api.ts` dialog result still reflects an older object-shaped facade. `_shared/operator-input.ts` is the narrow official-signature adapter for this migration; full facade repair is deferred.
