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
- In TUI mode `/ps` focuses the agent roster already visible below the editor instead of drawing a second copy. Its row membership and order stay fixed until close, live fields keep updating, and Up/Down can reach every leaf through the eight-row viewport. Reopen `/ps` to include agents that arrived while it was focused. Escape from a drill opened by `/ps` returns to `/ps` on the same row, with membership re-read on return; `q` leaves the agent surface for the editor instead, and so does a drill whose row retired while it was open.
- `/agent drill` uses the full viewport only when its request/transcript needs it. Short retained results stay top-aligned at their real content height; long results keep tail-follow plus Home/End/PageUp/PageDown and mouse history controls.
- Workflow completion rows retain the durable catalog identity and add the same session petname shown by `/ps`. Fresh JSONL/HTML transcript filenames include their stage and petname, and HTML browser titles use that human identity when the host export exposes a title element.
- Package-owned SDK children use a file-backed Pi session manager inside the owning run/report evidence directory and therefore do not appear beside operator sessions in `pi --resume`. Their durable named JSONL/HTML evidence is exported explicitly before disposal.

The catalog follows project -> user precedence: project `.agents/agents/`, then user `~/.agents/agents/`. The package ships no profiles.

## Implementation

- Entrypoint: `extensions/agents/index.ts`
- Tool: `extensions/agents/tool/task-tool.ts`
- Catalog: `extensions/agents/catalog/catalog.ts`
- SDK adapter: `extensions/_shared/agent-runtime/agent-sdk-host.ts`
- Manifest: `extensions/agents/manifest.json`
