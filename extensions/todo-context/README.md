# todo-context

`todo-context` owns session-backed todo state, explicit task bridges, and bounded opt-in queue continuation.

Beta: disabled by default. Nothing below is registered until the project enables `todo-context` — see [beta extensions](../../docs/getting-started.md#beta-extensions).

## Surface

- `todo_read` returns phases, active item, queue context, storage backend, and autonomous-mode state without mutating the queue.
- `todo_write` applies ordered operations and persists the resulting session state.
- `/todo` provides operator inspection, editing, queue controls, export, and explicit `.tasks` import/completion-note bridges.
- `agent_settled` may dispatch one hidden follow-up only when autonomous continuation is enabled and the previous turn recorded progress.

Continuation stops on an empty queue, pause, missing progress, dispatch failure, or the configured bounded limit. Session todos do not infer or mutate a project task unless the operator invokes an explicit bridge.

`.tasks` is local project state and is ignored by Git by default.

## Implementation

- Entrypoint: `extensions/todo-context/index.ts`
- Tools: `extensions/todo-context/todo-write-tool.ts`
- Queue: `extensions/todo-context/queue-controller.ts`
- Task bridges: `extensions/todo-context/task-bridge-commands.ts`
- Manifest: `extensions/todo-context/manifest.json`
