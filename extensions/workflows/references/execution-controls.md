# Execution controls and mapping identity

Audience: workflow authors and launcher/UI integrators. Runtime owners: `workflow-runtime.ts`, `workflow-budget.ts`, `workflow-journal.ts`; the [existing runtime manual](../REFERENCE.md) owns unchanged APIs/defaults.

## Existing parallel with explicit options

`parallel(thunks, { concurrency?, keys?, title? })` keeps its existing one-argument behavior. Options are closed. Concurrency is a positive safe integer. The default local scheduling width is unchanged; an explicit width changes this group's local scheduling only. Every physical child must still acquire the shared global leaf gate. A group wrapper reserves no agent slot, so nested groups do not deadlock by holding parent slots while waiting for children.

`keys` must be a full ordered list matching the number of branches, locally unique, nonblank, at most 240 characters per key and without control characters. Validation happens before any member starts. Nested business identity is the complete path; unkeyed nested levels contribute an explicit positional component. Keyed paths participate in replay request identity. Reordered keys do not silently reuse another item's answer. Unkeyed old calls retain their existing canonical shape.

`title` is bounded display text. A child `agent(..., { label, title })` keeps a literal callsite label and may derive title from author-known records. Titles do not affect replay identity. `parallel` results are in input order, not completion order; files and other effects are not implicitly ordered.

```js
const FIELDS = [
  { key: "id", question: "Exact ID?" },
  { key: "schedule", question: "Exact schedule?" },
];
const answers = await dsl.parallel(
  FIELDS.map((field) => () => dsl.agent(field.question, { label: "field", title: field.key })),
  {
    concurrency: 2,
    keys: FIELDS.map((entry) => entry.key),
    title: "Fields",
  },
);
```

This is the existing `parallel` primitive, not a new `parallel.map`. `pipeline` retains its existing per-item stage semantics. Discovered model values are opaque and cannot be destructured like author-owned records; the standard source checker owns that distinction.

## Shared run budget at the tool boundary

The existing `workflow` tool accepts optional `budget` with the existing seven axes: concurrency, totalAgents, runtimeMs, timeoutMs, toolCalls, turns and answerChars. Values are validated by the same runtime budget owner and displayed in the approval details. There is no second adaptive budget and no USD-cost claim. The command launcher carries this object for structured callers; the slash CLI syntax has not gained budget flags.

For the three-round refinement example with tool-return decisions, `totalAgents: 9` permits at most nine physical workflow children when transport retries are not enabled. In-session corrections still consume that child's cumulative turns/tools/time. With legacy text choice repair, reserve up to twelve physical children instead. Choose time/tool/answer bounds for the actual workload; do not reinterpret the package emergency defaults as an economical policy.

A complete structured invocation can narrow the budget, for example:

```json
{
  "scriptPath": "extensions/workflows/references/examples/refinement.workflow.mjs",
  "input": "Explicit goal and acceptance criteria",
  "budget": {
    "concurrency": 2,
    "totalAgents": 9,
    "runtimeMs": 600000,
    "timeoutMs": 180000,
    "toolCalls": 100,
    "turns": 10,
    "answerChars": 30000
  }
}
```

These values are illustrative operator choices, not new defaults. Budgets govern the DSL execution tree and supported saved children, not arbitrary hostile subprocesses or hidden tool-launched orchestration in this trusted host.

## Queue, phases and inspection

A fresh physical request emits `agent_queued` before gate admission. `agent_start` occurs only after admission/deadline checks, immediately before dispatch to the bridge. Neither event claims the first provider token has arrived. Replayed calls emit replay evidence without pretending they waited for a new child slot. Live rows distinguish queued from working.

`phase()` changes the current async branch's phase inside a group. A sibling cannot overwrite it; root phase remains unchanged. Group journal lines retain parent grouping and supplied titles. The top-level transcript ignores branch-local phase updates rather than displaying whichever sibling last ran.

Physical format attempts, logical calls, semantic refinement rounds and replayed calls are different counters. The refinement recipe publishes `round-N.md` with goal/work/review/decision and emits an explicit round log; structured choice logs expose validated versus fallback. Existing drill-down opens round evidence. No new global supervisor or automatic round is injected into a fixed graph.
