# todo-context

## Назначение

`todo-context` — active compat-wrapper для session-backed todo state. Он дает structured `todo_write` для агентов и `/todo` для operator-facing inspection и явных task-bridge команд. Локальная поверхность остается read-mostly: текущее todo-состояние живет в session entries, а не в `.tasks`.

## Поверхности

- Tool `todo_write`: обновляет session todo phases ordered OMP-compatible ops.
  Optional `context` and `autoContinue` fields attach the shared objective and
  explicitly enable or pause bounded queue execution.
- Command `/todo`: inspection и explicit task bridges.
  - `/todo append [<phase>] <task> [;; <task> ...]` atomically adds up to 20
    tasks; malformed or duplicate batches do not mutate state.
  - `/todo run [<context...>]` starts the active item and `/todo pause` disables
    future continuations without deleting queue state.
  - `/todo from-task <task-id>` seeds session todos from the exact `.tasks/index.json` entry.
  - `/todo current-task` reads `.tasks/index.json` and shows the unambiguous current project task.
  - `/todo completion-note [--yes] <task-id>` exports current session todos to `.tasks/<task>/artifacts/completion-note.md`. The extension always writes the artifact; the host's filesystem-write approval layer is the only gate (`permission: delegated-to-pi`). `--yes` / bare select an advisory `approvalTier` (`allow` / `prompt`) that is parsed for forward-compatibility but does **not** decide whether the write happens.
  - Остальные verbs: `show`, `edit`, `copy`, `export`, `append`, `start`, `done`, `drop`, `rm`.

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

## Как это работает

`extensions/todo-context/index.ts` регистрирует обе поверхности и settled hook.
Queue context и `autoContinue` сохраняются в backward-compatible metadata
существующих `todo_write` entries. Arm очищается до dispatch; только следующий
успешный progress op может разрешить еще один turn. `loadTaskBridgeSnapshot`
читает `.tasks/index.json`, `resolveCurrentProjectTask` выбирает current project
task только из project task metadata, `importTodosFromProjectTasks` превращает
explicit task в session todo phase, `exportTodosToProjectTask` сериализует
текущие session todos в task-artifact Markdown, а
`writeCompletionNoteWithApproval` сохраняет совместимое имя и **всегда**
выполняет explicit filesystem write — единственный gate это host
filesystem-write approval layer; `approvalTier` (`--yes → allow`, bare →
`prompt`) парсится, но не влияет на то, происходит ли запись. `tasksRoot(...)`
и resolved project task path из `extensions/_shared/tasks-store.ts` задают
workspace для artifact. Bridge не угадывает current task из todo/session state,
не мутирует `.tasks/index.json` и не auto-sync'ит task status.

## Ограничения

`todo-context` не является full task manager. Он не выполняет transcript
compaction, background scheduling, parallel queue items, automatic agent/model
routing, file import или automatic `.tasks` synchronization. `/todo export`
показывает deterministic Markdown, но не создаёт отдельный export file.

## Карта кода для сопровождения

- Entrypoint: `./extensions/todo-context/index.ts`
- Manifest: `extensions/todo-context/manifest.json`
- Commands: `todo`
- Tools: `todo_write`
- Hooks: `agent_settled`
- Permissions: fs.read=`.tasks/index.json`, fs.write=`.tasks/**/artifacts/completion-note.md`, subprocess=none, network=none, browser=false, models=true, ui=`editor`, `setWidget`
- State: latest phases, queue context, and autonomous mode restore from session-core JSONL when enabled, then from Pi custom `todo_write` entries via `ctx.sessionManager`, then from shared memory as fallback. Explicit task bridges read `.tasks/index.json` and write only `.tasks/<task>/artifacts/completion-note.md`.
- Review: status=reviewed, source=copy-after-audit, reviewedBy=locus-pi, reviewedAt=2026-07-19, risk=high
