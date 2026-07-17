# Source audit: todo-write

Decision: copy-after-audit, active compatibility wrapper. The current `todo-context` extension ports the core OMP `todo_write` mutation semantics and a compact `/todo` command subset into a local `locus-pi` compatibility surface that is loaded by default.

OMP source evidence:

- `oh-my-pi:packages/coding-agent/src/tools/todo-write.ts`
- `oh-my-pi:packages/coding-agent/src/modes/controllers/todo-command-controller.ts`
- `oh-my-pi:packages/coding-agent/src/slash-commands/helpers/todo.ts`
- `oh-my-pi:packages/coding-agent/src/prompts/tools/todo-write.md`
- `oh-my-pi:packages/coding-agent/test/tools/todo-write.test.ts`
- `oh-my-pi:docs/tools/todo_write.md`
- `oh-my-pi:LICENSE`

License note: OMP checkout is MIT-licensed. Local `todo_write` ports core mutation/result semantics and a small session-entry restore layer from the listed source evidence while leaving full UI behavior unported.

Ported contract:

- Primary tool name is `todo_write`.
- Slash command `/todo` supports show, `copy` as Markdown print, `export` as deterministic Markdown output, `append`, `start`, `done`, `drop`, `rm`, `edit`, explicit task seeding via `/todo from-task <task-id>`, and explicit completion-note writeback via `/todo completion-note [--yes] <task-id>` through the Pi editor API.
- `/todo edit` round-trips OMP-style Markdown checklist markers and blockquote notes.
- Supported ops are `init`, `start`, `done`, `drop`, `rm`, `append`, and `note`.
- Result details expose OMP-style `phases[]` with `name`, `tasks[]`, and task statuses `pending`, `in_progress`, `completed`, and `abandoned`.
- `done`, `drop`, and `rm` support task, phase, or all-task targeting.
- Bad references return `isError=true` with accumulated errors while preserving already-applied mutations.
- Task-like ids such as `task-1` return the OMP-style hint that tasks are referenced by content, not by IDs.
- `details.completedTasks[]` records newly completed tasks in the current batch.
- Latest phases are written to Locus session-core entries when JSONL storage is enabled. Pi custom entries written through `pi.appendEntry("todo_write", ...)` remain the compatibility path and are restored through `ctx.sessionManager.getEntries()`. Process memory is only the final fallback.
- `/todo from-task` and `/todo completion-note` are local task-bridge additions: the first seeds session todos from an exact `.tasks/index.json` task id, and the second writes current session todo markdown to `.tasks/<task>/artifacts/completion-note.md` with Pi-delegated write permission.
- T-205 changes only local presentation: slash-command paths use typed `Session todos` cards, short mutation receipts, bounded explicit export, and the official-signature input adapter. `todo_write` schema/result details and OMP-derived mutation semantics are unchanged.

Known gaps:

- Local storage is session-core backed when JSONL is enabled, but it is still not a full OMP session transcript integration.
- Local UI does not include OMP sticky todo panel, tree renderer, completion animation, reminder hooks, clipboard copy, or file import/export. `/todo export` is an explicit bounded screen view, not a file-export feature.
- Full OMP sticky todo panel, reminder hooks, clipboard copy, file import/export, and richer renderer remain unported enhancements.
