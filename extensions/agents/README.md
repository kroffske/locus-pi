# agents

`agents` owns the discovered agent catalog, child-session execution, `/agent`, `/ps`, and the model-callable `spawn_agent` tool.

## Surface

```text
/agent list
/agent inspect <name>
/agent run [--yes|--approve] [--title <title>] <name> <task>
/agent observe
/agent summary
/agent drill <row-id|agent|last>
/ps [row-id|agent|last]
```

`spawn_agent` accepts one required `task` plus optional `agent`, `title`, and explicit parent context. Omitting `agent` starts a clean child without a role profile. An explicit name resolves only from the project or user catalog.

## Contract and limits

- Unknown agents, unavailable SDK support, cancellation, failure, blocked execution, and empty answers return explicit errors.
- Direct child-to-child delegation is blocked by removing `spawn_agent` from child sessions.
- Read-only profiles are narrowed by the host adapter; they do not receive arbitrary write or shell tools.
- Parallel or multi-stage orchestration belongs to the workflow runtime, not one `spawn_agent` call.
- `/ps` and `/agent drill` inspect live and retained child rows; closing the view does not stop a child.
- In TUI mode `/ps` focuses the agent roster already visible below the editor instead of drawing a second copy. Recursive `├─`, `└─`, and `│` rails keep workflow groups, agents, latest messages, and tool activity attached across the focused viewport. Its row membership and order stay fixed until close, live fields keep updating, and Up/Down can reach every leaf through the eight-row viewport. Reopen `/ps` to include agents that arrived while it was focused. Escape from a drill opened by `/ps` returns to `/ps` on the same row, with membership re-read on return; `q` leaves the agent surface for the editor instead, and so does a drill whose row retired while it was open.
- `/agent drill` uses the full viewport only when its request/transcript needs it. Short retained results stay top-aligned at their real content height; long results keep tail-follow. Its header says where a workflow child sits — run, stage, enclosing group, agent — and one status line beneath it carries the row's state and how long it has been running.
- In Pi's regular mode Home, End, PageUp and PageDown move that history, in whichever encoding the terminal sends them: `ESC[1~`/`ESC[4~` under `tmux-256color`, `ESC O H`/`ESC O F` under `xterm-256color`, and the `ESC[H`/`ESC[F` pair. Home and End used to answer to the last pair alone, so both keys were dead in tmux.
- In Pi fullscreen the screen's history does not scroll at all, and the footer promises no history control there. This is a host limitation the component cannot route around: Pi's alt-screen TUI registers a viewport input listener in its own constructor, before any component exists (`@earendil-works/pi-tui/dist/tui-alt-screen.js:77`), that listener consumes PageUp, PageDown, Home and End for `tui.altScreen.pageUp`/`pageDown`/`top`/`bottom` (`@earendil-works/pi-tui/dist/keybindings.js:91-116`), and every input listener runs to completion before the focused component is reached (`@earendil-works/pi-tui/dist/tui.js:557`). The wheel is Pi's there by design, so in fullscreen a transcript taller than the viewport is readable only at its tail. An operator who rebinds those four `tui.altScreen.*` actions gets the keys back, because the screen still handles them.
- Fullscreen costs the screen one row. Pi mounts the component in a dock stacked under a transcript `ScrollView` that never shrinks below one line, so a screen claiming every row but Pi's footer had its own footer clipped off the bottom with nowhere to scroll to. The screen reserves that row and gives up one line of transcript instead.
- The agent screen no longer enables terminal mouse tracking in regular mode, so the wheel and the host terminal's own scrollback stay with the terminal and history moves by key. `LOCUS_DRILL_MOUSE=1` restores the previous wheel-scrolled history, and the footer offers `wheel` only where the screen captures it. In Pi fullscreen the screen writes no mouse sequences at all and leaves wheel reports to Pi; a host that gives the component a terminal wrapper with no mode is treated the same way, so the variable has no effect there (`extensions/workflows/REFERENCE.md`).
- The reply box is Pi's own editor component mounted whole, with its frame and its own key hints. It needs 18 terminal rows; below that the screen says `resize terminal for input` instead.
- Workflow completion rows retain the durable catalog identity and add the same session petname shown by `/ps`. Fresh JSONL/HTML transcript filenames include their stage and petname, and HTML browser titles use that human identity when the host export exposes a title element.
- Package-owned SDK children use a file-backed Pi session manager inside the owning run/report evidence directory and therefore do not appear beside operator sessions in `pi --resume`. Their durable named JSONL/HTML evidence is exported explicitly before disposal.

The catalog follows project -> user precedence: project `.agents/agents/`, then user `~/.agents/agents/`. The package ships no profiles.

## Implementation

- Entrypoint: `extensions/agents/index.ts`
- Tool: `extensions/agents/tool/task-tool.ts`
- Catalog: `extensions/agents/catalog/catalog.ts`
- SDK adapter: `extensions/_shared/agent-runtime/agent-sdk-host.ts`
- Manifest: `extensions/agents/manifest.json`
