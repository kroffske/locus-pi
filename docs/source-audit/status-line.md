# status-line source audit

## Decision

The extension is a local Locus implementation over public Pi 0.82.0 extension
APIs. It replaces only the rendered footer component; Pi remains the owner of
the editor, session history, context accounting, Git watcher, extension-status
registry, and compaction mechanics.

## Upstream contracts used

- `ctx.ui.setFooter` installs one footer factory and supplies Pi's read-only
  footer data provider.
- `ctx.getContextUsage()` supplies current context use and can report unknown
  tokens immediately after compaction.
- `session_before_compact` and `session_compact` expose lifecycle state without
  replacing Pi's compaction algorithm.

## Local behavior

`extensions/status-line/footer.ts` owns rendering and width projections.
`extensions/status-line/index.ts` owns lifecycle registration and restores the
native footer on shutdown. The violet bar is presentation only; every state
remains legible as plain text when ANSI styling is removed.

The implementation does not claim that automatic compaction is enabled or that
Locus owns a custom policy. `(pi:auto)` names the actual owner and current mode.
Missing post-compaction context stays unknown rather than becoming zero.
