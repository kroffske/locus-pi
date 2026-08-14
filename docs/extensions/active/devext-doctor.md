# devext-doctor

## Purpose

`devext-doctor` keeps two read-only operator diagnostics:

- `/devext doctor` summarizes the declared extension inventory;
- `/devext task-lifecycle <task-id> <target-status>` previews a task transition and its missing preconditions without mutating `.tasks`.

## Removed reload surfaces

`devext_reload`, `/devext reload`, and `/devext hot-reload` were removed. The tool could not reload current Pi because `ctx.reload()` is exposed only to slash-command contexts, so it always returned blocked. The command duplicated Pi's built-in `/reload`. Use the host's `/reload` command or restart Pi.

## Code map

- Entrypoint: `extensions/devext-doctor/index.ts`
- Commands: `devext doctor`, `devext task-lifecycle <task-id> <target-status>`
- Tools: none
- Hook: shared `input` cleanup lifecycle
- State: read-only extension inventory and task bridge snapshot
