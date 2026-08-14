# agents

## Purpose

`agents` owns the local agent catalog, `/agent`, `/ps`, live child-session UI, and one model-callable delegation tool: `spawn_agent`.

## Public contract

- `spawn_agent` accepts one required `task`, plus optional `agent`, `title`, and `parentContext` fields.
- One call creates one real headless child through Pi's public `createAgentSession` SDK API and returns the child's exact non-empty final text.
- Missing SDK support, unknown agents, empty answers, cancellation, and failed or blocked children return an honest error.
- Direct child-to-child delegation is blocked by excluding `spawn_agent` from child sessions.
- `/agent` and `/ps` remain operator commands for catalog inspection, execution, observation, drill-down, and cancellation.

`createAgentSession` is a Pi SDK function, not a Locus implementation. Locus owns the adapter that selects a catalog profile, configures the SDK session, collects lifecycle evidence, and projects the result.

The removed `task` tool was a second registration of the same executor and schema. It did not provide a separate capability. `locus_workload_proof` was also removed: it wrote a model-supplied claim to `.locus/runtime/agent-workload-proof/*.json`, while the active SDK executor already derives workload evidence from real child lifecycle events and never consumed that claim to decide success.

## Code map

- Entrypoint: `extensions/agents/index.ts`
- Tool registration: `extensions/agents/task-tool.ts`
- SDK adapter: `extensions/_shared/agent-runtime/agent-sdk-host.ts`
- Tools: `spawn_agent`
- Commands: `agent`, `ps`
- Hooks: `session_start`, `before_agent_start`
- State: discovered profiles, live child rows, result/diagnostic artifacts

## Limits

One tool call runs one child. Parallel or multi-stage orchestration belongs to workflows. The default agent profile is still named `task`; that catalog profile name is not a tool alias.
