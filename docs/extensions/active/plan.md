# plan

`plan` is the default-loaded surface for explicit behavioral plan mode (`/plan`
and `/mode plan|default`), the `/review` and `/todos` prompt shelves, and the local goal runtime.

> **Current truth (v2, behavioral mode):** plan mode is **BEHAVIORAL**, not a
> permission boundary. While the active mode is `plan`, a `before_agent_start`
> injection frames the model to **compose a plan, not implement** — and **standard
> commands and throwaway scripts are allowed** (no read-only block). `/plan
<request>` additionally authors a plan and saves the **output** to a user-level
> file. Bare `/plan` first opens an `[INPUT]` dialog and only authors after submit.
> Modes remain a named list (`default`, `plan`), but mode changes are explicit:
> bare `/mode` only shows state, `/mode plan` enters, and `/mode default` exits.
> Session start clears a persisted active mode, so a restart/reload cannot silently
> put the next turn into planning. `/review`, `/todos`, and `/goal prompt`
> are **summary-first prompt shelves** (no mode): bare inspection shows target,
> kind, path, and size; full body requires explicit `show`/`read`. The
> machine-readable contract is [extensions/plan/manifest.json](../../../extensions/plan/manifest.json).

## Who uses it

Operators use slash commands. Models use the `goal` tool. No keyboard shortcut changes behavioral mode.

## Commands

- `/plan` opens a typed input dialog whose title names the desired end state; Pi may omit placeholder text in some TUI builds. Submit follows the same authoring path as `/plan <request>` exactly once; Escape creates no plan and does not change mode.
- `/plan <request>` arms plan mode and authors a plan from `<request>`, saved to `~/.pi/locus-pi/<project-slug>/plans/<plan-slug>.md`.
- `/plan exit` leaves plan mode and clears the status label. With a composed plan it first opens the plan→execution handoff selector (see below).
- `/plan list` and `/plan help` use typed `VIEW` blocks. `/plan open <slug>` shows a bounded typed `CHANGE` preview and re-arms plan mode; missing/unknown slugs use `WARN`.
- `/mode` and `/mode show` show the current mode without changing it; `/mode plan` and `/mode default` are the only `/mode` mutations.
- `/review` and `/todos` show typed shelf summaries. `/review show|read` and `/todos show|read` explicitly show the bounded body.
- `/review set <prompt>` and `/todos set <prompt>` are explicit writes; legacy free-form `<prompt>` remains compatible and its save receipt marks the syntax deprecated, with the equivalent `set` command. `set show`/`set read` stores those literal words.
- `/goal <objective>` creates or replaces local goal state.
- `/goal show` shows the current goal summary.
- `/goal budget <N|off>` sets or clears the token budget.
- `/goal pause`, `/goal resume`, `/goal complete`, and `/goal drop` mutate the active goal state.
- `/goal set <objective>` remains a compatibility alias for create/replace.
- `/goal prompt` shows the Goal prompt shelf summary; `/goal prompt show|read` opens its bounded body; `/goal prompt set <text>` writes explicitly. Legacy `/goal prompt <text>` remains compatible and its save receipt marks the syntax deprecated, with the equivalent `set` command.
- `/goal continue` writes a bounded continuation prompt artifact.
- `/goal-ai` opens a typed editor whose title asks for the prompt outcome. Submit runs one replacement-session draft; Escape writes no prompt artifact.
- `/goal-ai <request>` asks an LLM to draft a Locus Prompt Draft and saves it as a goal prompt.

## Tool

- `goal` supports `create|get|complete|resume|drop`.
- The tool stores state in `.locus/runtime/goal/state.json`.

## Explicit modes

- `default` is normal execution; `plan` adds a planning framing. The values stay
  named and extensible, but there is no implicit cycle route.
- The extension never registers Shift+Tab for mode changes and never edits Pi's
  `keybindings.json`. Bare `Tab`, Shift+Tab, arrows, Enter, and selector navigation
  cannot activate plan mode.
- `session_start` writes the cleared mode sentinel before installing visual cues.
  Saved plan artifacts remain available through `/plan list` and can be explicitly
  re-armed with `/plan open <slug>`.
- Plan mode shows **two visual cues**, cleared on `default`:
  1. A bounded route contribution owned as `plan.mode` and rendered through the
     shared `status:locus` line. Wide terminals show the active plan label;
     compact and narrow terminals reduce it to `MODE plan` or `PLAN`. The
     extension does not allocate a second permanent status row. In TUI mode this
     contribution uses the warning tone (normally yellow) instead of footer white.
  2. A recolored **input-editor border** — at `session_start` the extension
     installs a `CustomEditor` subclass via `ctx.ui.setEditorComponent` whose
     border getter returns the warning color while plan mode is active and defers
     to Pi's normal (thinking/bash) border color otherwise. Both cues share the
     warning color so plan mode reads the same in the badge and at the input.

## Plan → execution handoff (on exit)

Leaving plan mode **with a composed plan** via `/plan exit` or explicit
`/mode default` opens a `ctx.ui.select` prompt asking what to do with the plan:

1. **Execute the plan (this context)** — exit plan mode and inject the saved plan
   into the current session as a follow-up (`pi.sendUserMessage`, `deliverAs:
followUp`) so the model executes it in place.
2. **Execute with a fresh context (reset)** — `ctx.newSession`, then seed the new
   session with the plan and execute from a clean slate (start over).
3. **Tweak, then execute** — prompt for a small amendment through the typed input
   adapter, fold it into the plan, then execute in this context.
4. **Keep planning** — stay in plan mode untouched. Dismissing the prompt (Esc)
   does the same.

Escape from the selector or tweak input means **Keep planning**: the mode and
saved plan remain unchanged and no execution message is queued.

The handoff degrades to a **plain exit** (the prior behavior) when the UI is
headless (`hasUI !== true`) or there is no composed plan artifact — e.g. when plan
mode was entered by explicit `/mode plan` rather than
`/plan <request>`.
The selector reuses Pi's built-in `ctx.ui.select`; tweak text goes through the
local official-signature input adapter. No LLM-callable tool is
involved in this flow (the separate `ask` tool lives in the
`ask-user-question` extension).

## Hook

- `before_agent_start` appends `<goal_context>` only for active, paused, or budget-limited goals; complete and dropped goals do not inject.
- The same `before_agent_start` handler appends a `<planning_mode>` block while the active mode is `plan` — a behavioral instruction to plan rather than implement, explicitly allowing commands and throwaway scripts. It does **not** block any tool.
- There is **no** `tool_call` block hook. v1's read-only enforcement was removed in v2; plan mode never blocks writes or subprocesses.

## Spell map

What you type, the good visible result, and the bad result to watch for.

| Spell                               | What it does now                                                                                                                                                   | Good visible result                                                                                                                                          | Bad result                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `/plan`                             | Opens typed input, then arms plan mode and authors one plan after submit.                                                                                          | `[INPUT] Plan request` is visually distinct; Escape returns a cancelled receipt and writes nothing.                                                          | Empty or cancelled input creates a plan or triggers a model turn.                                          |
| `/plan <request>`                   | Arms plan mode, authors a plan, saves the output to the user-level plans dir.                                                                                      | Shared `locus` status shows the bounded plan-mode route; a typed result reports the saved path; the planning framing is injected but all tools stay allowed. | Saves the raw input verbatim, or a tool call gets blocked (v2 never blocks).                               |
| `/plan exit`                        | Leaves plan mode; with a composed plan, opens the execution-handoff selector.                                                                                      | Selector offers execute / execute-fresh / tweak / keep; on execute the plan is injected as a follow-up and the label clears; on keep the `PLAN` label stays. | Selector appears with no composed plan, or the plan is not injected on execute.                            |
| `/plan list` / `/plan help`         | Shows the saved-plan library or explicit usage.                                                                                                                    | Typed `VIEW` block, bounded rows, muted path/controls.                                                                                                       | Falls back to an unframed white-text stack.                                                                |
| `/plan open <slug>`                 | Loads a saved plan and re-arms plan mode.                                                                                                                          | Typed `CHANGE` preview with `PLAN`, path, bounded body, and an explicit `+N more` affordance.                                                                | Unknown slug looks like success, or a long plan overflows/truncates silently.                              |
| `/mode [show                        | plan                                                                                                                                                               | default]`                                                                                                                                                    | Bare/show is read-only; named commands are the only mode mutations.                                        | A typed view or change receipt appears; explicit plan mode uses a yellow warning-tone badge and border.                                                                       | Bare `/mode`, restart, workflow launch, Tab, arrows, or Enter activates plan mode.         |
| `/goal <objective>`                 | Creates or replaces the long-lived Goal state.                                                                                                                     | Typed `CHANGE` names the objective, status, id, usage/budget, and state path.                                                                                | Confuses runtime state with a prompt shelf.                                                                |
| `/goal prompt [show                 | read                                                                                                                                                               | set <prompt>]`                                                                                                                                               | Inspects or writes the separate Goal prompt shelf.                                                         | Bare command is summary-only; explicit body view shows `target`, `kind`, compact path, and bounded content; legacy writes save data and point to `/goal prompt set <prompt>`. | Bare inspection dumps the full prompt or silently falls back from an explicit task target. |
| `/goal-ai [<request>]`              | With no argument, opens typed input; then converts rough intent into a Locus Prompt Draft through one replacement-session LLM run and saves it as the goal prompt. | Typed result shows the resolved `target`, `kind`, local `path`, and child session id when available.                                                         | Pretends to execute the goal, writes after Escape, or overwrites `goal.md` after invalid/empty LLM output. |
| `/review [show                      | read                                                                                                                                                               | set <prompt>]`                                                                                                                                               | Inspects or writes the Review prompt shelf.                                                                | Bare summary hides body; explicit body view is typed and bounded; legacy writes save data and point to `/review set <prompt>`.                                                | Treats prompt storage as review execution proof.                                           |
| `/todos [show                       | read                                                                                                                                                               | set <prompt>]`                                                                                                                                               | Inspects or writes the Todos prompt shelf.                                                                 | Label is exactly `Todos prompt shelf`, distinct from `/todo` Session todos; legacy writes save data and point to `/todos set <prompt>`.                                       | Mixes prompt storage with session todo state or hidden `.tasks`.                           |
| `/<kind> --task <task-id> <prompt>` | Saves a prompt to an explicit task artifact.                                                                                                                       | Widget shows `target: task:<task-id>` and `path: ./.tasks/<task-dir>/artifacts/<kind>-prompt.md`.                                                            | Falls back to project-local storage after a missing or stale task id.                                      |

## Task-backed artifact route

When a command is invoked with `--task <task-id>`, the surface resolves
`.tasks/index.json` and writes `./.tasks/<task-dir>/artifacts/<kind>-prompt.md`
instead of the project-local prompt file. The command widget then reports
`target: task:<task-id>` and the task artifact `path`. This route fails closed if
the task id cannot be resolved; it does not silently fall back to project-local
storage.

## Proof gates

Every implementation slice on this surface should run:

```bash
jq '.pi.extensions' package.json
npm run check
```

When a slice changes the default package surface or published package contents,
also run:

```bash
npm pack --dry-run --json
```

Runtime smoke is required before claiming real agent execution, child workload,
task lifecycle, or review outcome. Prompt storage is not execution proof.

## Do not

- Do not call parser-clean output child workload proof.
- Do not reintroduce `/go` as an alias or compatibility command.
- Do not depend on external Locus skill prompts at runtime.
- Do not write hidden context without a source-truth contract.
- Do not create `.tasks` from these commands until a separate product decision
  reopens that bridge.

## Limitations

- `/goal prompt` and `/goal-ai` are prompt-writing surfaces, not goal execution.
- Bare `/plan` and `/goal-ai` depend on interactive UI. In `json`/`print` or explicit no-UI hosts they take no action; callers must provide the request as a command argument.
- Pi's official dialog result is `string | undefined`, while `_shared/host/pi-api.ts` still describes an older object result. These commands use the narrow `_shared/operator/operator-input.ts` adapter; repository-wide facade repair is deferred.
- `/review`, `/todos`, `/goal prompt`, `/goal-ai`, and `/goal continue`
  are artifact-write surfaces. Bare shelf commands show metadata/path and are
  transient. Full prompt bodies remain hidden until explicit command verbs
  `show`/`read` (or direct file inspection). `/plan` is now a mode (above), not a shelf;
  its `plan.mode` status contribution and editor-border cue persist until `/plan exit`
  or explicit `/mode default`, while each command/result widget remains transient.
- `/goal show` and goal lifecycle commands render a bounded command summary.
  The durable source of truth remains `.locus/runtime/goal/state.json`.
- Plan mode is **behavioral**: it influences the model via a system-prompt
  injection only. It does **not** restrict tools, writes, or the operator's shell —
  by design (v2). The model is _asked_ to plan, not _forced_ to.
- Behavioral mode has no keyboard shortcut. The extension does not modify Pi's
  `keybindings.json`; use `/mode plan`, `/mode default`, or `/plan`.
- The plan→execution handoff needs interactive UI; in headless/print mode
  (`hasUI !== true`) leaving plan mode is always a plain exit with no selector.
- There is no OMP-native continuation/footer parity or exact token-accounting proof.
- The former standalone beta goal shell is excluded; goal lifecycle behavior is owned here.

## Stop conditions

Stop and ask for a user decision if any of these become true:

- The only way to launch agents is parent-session `pi.sendUserMessage`.
- `/plan`, `/goal`, `/review`, or `/todos` would need hidden task state to work.
- `/review` would need to send unbounded session history or secret data to a child model.
- A compatibility request requires preserving `/go`.
- A proposed prompt command starts guessing `.tasks` state or depending on Locus skills without a separate accepted product decision.
