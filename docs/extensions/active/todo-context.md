# todo-context

## Purpose

`todo-context` is an active compat-wrapper for session-backed todo state. It gives agents a structured `todo_write` and operators `/todo` for inspection and explicit task-bridge commands. The local surface stays read-mostly: the current todo state lives in session entries, not in `.tasks`.

## Surfaces

- Tool `todo_write`: updates session todo phases through ordered OMP-compatible ops.
  Optional `context` and `autoContinue` fields attach the shared objective and
  explicitly enable or pause bounded queue execution.
- Command `/todo`: inspection and explicit task bridges.
  - `/todo append [<phase>] <task> [;; <task> ...]` atomically adds up to 20
    tasks; malformed or duplicate batches do not mutate state.
  - `/todo run [<context...>]` starts the active item and `/todo pause` disables
    future continuations without deleting queue state.
  - `/todo from-task <task-id>` seeds session todos from the exact `.tasks/index.json` entry.
  - `/todo current-task` reads `.tasks/index.json` and shows the unambiguous current project task.
  - `/todo completion-note [--yes] <task-id>` exports current session todos to `.tasks/<task>/artifacts/completion-note.md`. The extension always writes the artifact; the host's filesystem-write approval layer is the only gate (`permission: delegated-to-pi`). `--yes` / bare select an advisory `approvalTier` (`allow` / `prompt`) that is parsed for forward-compatibility but does **not** decide whether the write happens.
  - The remaining verbs: `show`, `edit`, `copy`, `export`, `append`, `start`, `done`, `drop`, `rm`.

## Operator UI contract

- Bare `/todo`, `show`, and `list` render a typed `VIEW` named `Session todos`; an empty state is a `WARN` with one add action. This is intentionally different from `/todos`, whose label is `Todos prompt shelf` and whose storage is a project/task artifact.
- State views show bounded checklist rows, counts, active task, and `storageBackend`. Long content uses the shared hidden-count budget; `/todo export` is the explicit Markdown body view.
- `append`, `start`, `done`, `drop`, `rm`, editor submit, `from-task`, and completion-note return short typed changes. Mutation receipts do not repeat the whole list.
- `/todo edit` uses Pi's official `editor(title, prefill) -> string | undefined` contract through `_shared/operator-input.ts`. Escape is a no-write `RESULT`; malformed Markdown is a no-write `WARN`; unexpected dialog failures are `ERROR` and do not claim success.
- Task bridges remain explicit. Missing/ambiguous task ids show the chosen target and never fall back or infer the current task from session todos.
- Autonomous mode is opt-in. After a successful progress mutation,
  `agent_settled` may trigger one hidden custom follow-up for the next active
  item. The message is model context, not a synthetic user message.
- The chain stops on an empty queue, explicit pause, a response without a
  progress mutation, dispatch failure, or 20 automatic continuations.

## How it works

`extensions/todo-context/index.ts` registers both surfaces and the settled hook.
Queue context and `autoContinue` are stored in backward-compatible metadata of
existing `todo_write` entries. The arm is cleared before dispatch; only the next
successful progress op can allow another turn. `loadTaskBridgeSnapshot`
reads `.tasks/index.json`, `resolveCurrentProjectTask` picks the current project
task only from project task metadata, `importTodosFromProjectTasks` turns an
explicit task into a session todo phase, `exportTodosToProjectTask` serializes
the current session todos into task-artifact Markdown, and
`writeCompletionNoteWithApproval` keeps its compatible name and **always**
performs an explicit filesystem write — the only gate is the host
filesystem-write approval layer; `approvalTier` (`--yes → allow`, bare →
`prompt`) is parsed but does not affect whether the write happens. `tasksRoot(...)`
and the resolved project task path from `extensions/_shared/tasks-store.ts` set the
workspace for the artifact. The bridge does not guess the current task from todo/session state,
does not mutate `.tasks/index.json`, and does not auto-sync task status.

## Limitations

`todo-context` is not a full task manager. It does not perform transcript
compaction, background scheduling, parallel queue items, automatic agent/model
routing, file import, or automatic `.tasks` synchronization. `/todo export`
shows deterministic Markdown but does not create a separate export file.

## Code map for maintainers

- Entrypoint: `./extensions/todo-context/index.ts`
- Manifest: `extensions/todo-context/manifest.json`
- Commands: `todo`
- Tools: `todo_write`
- Hooks: `agent_settled`
- Permissions: fs.read=`.tasks/index.json`, fs.write=`.tasks/**/artifacts/completion-note.md`, subprocess=none, network=none, browser=false, models=true, ui=`editor`, `setWidget`
- State: latest phases, queue context, and autonomous mode restore from session-core JSONL when enabled, then from Pi custom `todo_write` entries via `ctx.sessionManager`, then from shared memory as fallback. Explicit task bridges read `.tasks/index.json` and write only `.tasks/<task>/artifacts/completion-note.md`.
- Review: status=reviewed, source=copy-after-audit, reviewedBy=locus-pi, reviewedAt=2026-07-19, risk=high
