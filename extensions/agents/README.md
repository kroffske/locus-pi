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

`spawn_agent` accepts one required `task` plus optional `agent`, `title`, and explicit parent context. One call starts one real headless child through Pi's `createAgentSession` API and returns the exact non-empty final child text.

## Contract and limits

- Unknown agents, unavailable SDK support, cancellation, failure, blocked execution, and empty answers return explicit errors.
- Direct child-to-child delegation is blocked by removing `spawn_agent` from child sessions.
- Read-only profiles are narrowed by the host adapter; they do not receive arbitrary write or shell tools.
- Parallel or multi-stage orchestration belongs to the workflow runtime, not one `spawn_agent` call.
- `/ps` and `/agent drill` inspect live and retained child rows; closing the view does not stop a child.

The catalog follows project -> user -> package precedence: project `.agents/agents/`, user `~/.agents/agents/`, then the bundled package catalog. First name wins.

## Implementation

- Entrypoint: `extensions/agents/index.ts`
- Tool: `extensions/agents/task-tool.ts`
- Catalog: `extensions/agents/catalog.ts`
- SDK adapter: `extensions/_shared/agent-runtime/agent-sdk-host.ts`
- Manifest: `extensions/agents/manifest.json`
