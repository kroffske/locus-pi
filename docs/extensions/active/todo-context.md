# todo-context

## Purpose

`todo-context` owns session-backed todo state, explicit task bridges, and bounded opt-in queue continuation.

## Surface

- `todo_read` returns the current phases, active item, queue context, storage backend, and autonomous-mode state without writing a session entry or changing the queue.
- `todo_write` applies ordered OMP-compatible operations and persists the resulting session state.
- `/todo` provides operator inspection, editing, queue control, deterministic export, and explicit `.tasks` import/completion-note bridges.
- `agent_settled` may dispatch one hidden follow-up only when `autoContinue` is enabled and the preceding turn recorded progress.

The chain stops on an empty queue, explicit pause, missing progress, dispatch failure, or 20 automatic continuations. Session todos never infer or mutate a project task unless the operator invokes an explicit task bridge.

## Code map

- Entrypoint: `extensions/todo-context/index.ts`
- Tools: `todo_read`, `todo_write`
- Command: `todo`
- Hook: `agent_settled`
- State: session-core/Pi todo entries with in-process fallback; explicit task bridges read `.tasks/index.json`
