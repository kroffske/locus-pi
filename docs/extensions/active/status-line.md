# status-line

`status-line` owns the responsive Locus footer loaded in interactive Pi sessions.
It leaves Pi's input editor unchanged and paints a dark-violet information rail
under it.

The wide projection anchors the real working directory plus `(branch)` on the
left. The right edge is always ordered as `context (pi:auto) model effort`, for
example `5%/272k (pi:auto) gpt-5.6-sol high`. The context percentage already
expresses current token pressure, so the footer does not repeat cumulative
input/output usage or add `ctx:`, `tok:`, or `git:` labels. The footer uses one
row whenever both full groups fit. On overflow it moves the right group to a
second, right-aligned row instead of dropping content. If either group cannot
fit even on its own row, only that group uses a shorter projection.

`(pi:auto)` is deliberate: Pi still owns compaction policy. While Pi compacts,
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
- UI owner: Pi's custom-footer slot in TUI mode; one row by default, two on overflow
- Focused tests: `tests/extensions/status-line/status-line.test.ts`
