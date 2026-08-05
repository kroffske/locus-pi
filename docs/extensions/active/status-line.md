# status-line

`status-line` owns the one-row Locus footer loaded in interactive Pi sessions.
It leaves Pi's input editor unchanged and paints a dark-violet information rail
under it.

The wide projection shows the active model and effort, real working directory,
linked Git worktree when present, branch, current context use, cumulative input
and output tokens, compaction state, and status text published by other
extensions. Narrow terminals drop low-priority location detail before context,
tokens, or compaction state. The component always returns exactly one line.

`compact:Pi` is deliberate: Pi still owns compaction policy. While Pi compacts,
the footer shows `COMPACTING`; immediately afterward it shows the recorded
pre-compaction size and either the measured new context or `measuring…` when Pi
has not produced a post-compaction context estimate yet. No custom Locus
compaction algorithm is implied.

The extension reads `.git` only to distinguish a linked worktree from an
ordinary checkout. It performs no subprocess, network, model, or filesystem
write operations.

## Public contract

- Entrypoint: `./extensions/status-line/index.ts`
- Manifest: `extensions/status-line/manifest.json`
- Commands/tools: none
- Hooks: `session_start`, `session_before_compact`, `session_compact`, `session_shutdown`
- UI owner: Pi's single custom-footer slot in TUI mode
- Focused tests: `tests/extensions/status-line/status-line.test.ts`
