---
name: locus-pi-workflows
description: Find, run, inspect, design, and build locus-pi workflows. Use for saved `.workflow.mjs` agent graphs, workflow run artifacts, or any request to create a workflow.
---

# locus-pi workflows

A workflow is reviewed trusted JavaScript that makes a visible graph of child
`agent()` calls. JavaScript owns order, branches, bounded loops, exact handoffs,
and publication. Agents own interpretation and complete reader-facing text.

This skill has two jobs: operate existing workflows and author new ones.

## Operate an existing workflow

```text
/workflows list
/workflows info <name>
/workflows run <name|path> [semantic text input]
/workflows status <runId>
/workflows result <runId|last>
/workflows continue <runId>
/workflows stop [runId|last]
```

Project workflows resolve first from `.pi/workflows/<name>.workflow.mjs`, then
`.claude/workflows/`, `.agents/workflows/`, `~/.pi/workflows/`, and finally the
Package examples. Run evidence lives under
`.pi/locus-pi/workflows/<runId>/`; `outputs/` contains published documents and
`result.json` contains the terminal envelope.

When a run ends with `awaiting_operator`, inspect its question and artifacts,
then use `/workflows continue <runId>` to answer the named handoff. Use
`/workflows stop [runId|last]` for cancellation; stopping is not a continuation
answer and terminal cancellation follows runtime settlement.

## Authoring is two explicit turns

Never turn a raw request directly into `.workflow.mjs`.

1. Send the requirement to the bundled `workflow-author` agent as a Design
   request. It writes only `.pi/workflows/<name>.design.md`.
2. Show that Markdown design to the user. Stop for explicit approval or revision.
3. Only the exact request `Build approved design: <exact design path>` authorizes
   the agent to create the matching `.workflow.mjs`. Build validates identity and
   module load, but does not run the workflow.

That command approves the design bytes present at the exact path when Build
reads it. This protocol has no separate approval token or stored digest; review
the current file immediately before issuing Build.

Use `/agent run workflow-author` or the `task` tool. A plain authoring request is
always interpreted as Design, never Build. Approval cannot be inferred from
“create a workflow”, previous conversation, or the existence of a design file.

If the user revises the graph, update the design and ask again. If Build discovers
a material algorithm change, return to Design instead of hiding the change in
source.

## Design contract

The design is short Markdown a reader can approve without opening JavaScript:

```markdown
# Design: <name>

Purpose: <one sentence>
Input: <semantic text or none>
Primary output: `<name>.md`
Pattern: <catalog pattern, or why none fits>

1. <numbered algorithm>

| Node     | Responsibility         | Receives      | Returns                              | Capability        | Next       |
| -------- | ---------------------- | ------------- | ------------------------------------ | ----------------- | ---------- |
| `<node>` | <one coherent subtask> | <exact input> | <complete text, choice, or handoffs> | <tools/read-only> | <consumer> |

Concurrency: <groups or none>
Loop bounds: <bounds or none>
Failure exits: <fail-closed exits>
Mechanisms: <parallel barriers, choices, loops, human gates; no agent-count penalty>
Status: DRAFT — waiting for operator approval.
```

Count orchestration machinery, not agents. More agents are fine when the task
really decomposes into more coherent subtasks.

Read [`references/INDEX.md`](./references/INDEX.md), then only the selected
pattern card. The cards are algorithms and small snippets, not full workflows to
copy blindly.

## Standard source profile

Declare stable agent identity and capability options together near the top. Keep
every prompt, call, branch, and exact handoff visible where it executes.

```js
const AGENTS = {
  reviewer: { agent: "reviewer", readOnly: true },
  composer: { tools: [], maxToolCalls: 0 },
};

export default async function run({ agent, parallel, phase, publishPrimaryArtifact }, input) {
  phase("review");
  const reviews = await parallel([
    () => agent(`Review contract:\n${input}`, { ...AGENTS.reviewer, label: "contract-review" }),
    () => agent(`Review evidence:\n${input}`, { ...AGENTS.reviewer, label: "evidence-review" }),
  ]);

  phase("compose");
  const document = await agent(`Write the complete review:\n${reviews.join("\n\n")}`, {
    ...AGENTS.composer,
    label: "compose-review",
  });
  return publishPrimaryArtifact("review.md", document);
}
```

Standard agent answers have three forms:

- Exact text. Pass it unchanged to the named consumer. A composer or reviewer
  returns the complete replacement document; publish that exact text.
- `choice`. Use `agent(prompt, { choice: ["accept", "revise"] })` only when
  JavaScript must select a branch. Runtime owns format instructions, one repair,
  parsing, validation, journal evidence, replay, and fail-closed exhaustion.
- `handoffs`. Use `agent(prompt, { handoffs: { maxItems: 64 } })` when one
  discovery call must return a bounded runtime list of complete text work units.
  Runtime owns the array shape, blank/duplicate rejection, bounds, repair,
  replay, and failure; workflow code receives `string[]` and uses `parallel()`.

`agent()` is the only model-calling primitive. `parallel()` is the fail-closed
barrier for independent known calls; `pipeline()` handles fixed ordered stages
per known item; `awaitOperator()` declares a human gate; `promptFile()` may hold
a long charter but never hide routing.

Give filesystem agents an explicit location contract in their prompt. Read-only
agents receive `projectRoot()` as their `pwd` and must treat source paths as
relative to it. Write agents receive the exact `runWorkspaceDir()` or retained
`workspace()` path and the exact relative output filename. Say explicitly that
they must not substitute the user's home directory or `/tmp`. This location text
is part of the task prompt; do not add JavaScript path parsers or collector
scripts to compensate for a weak model.

Workflow input remains semantic text. Standard source does not encode a hidden
line/CSV/JSON protocol and then `split`, regex-match, or parse it into branch
units. Fixed fan-out units are author-known and visible in design/source. When
units are runtime-discovered, use `agent({ handoffs })` to return bounded complete
text work units, then keep every downstream `parallel()` call and handoff visible.

## Forbidden in standard generated source

- raw `schema` or `validate`;
- input splitting, JSON/prose parsers, regex gates, coverage assertions, or
  domain validators;
- Markdown/table/report renderers;
- hand-written retries, broad `try/catch`, partial-result envelopes, or custom
  failure recovery;
- wrappers or registries around `agent()` that hide prompts and edges;
- domain-specific runtime helpers;
- a large structured plan used to fake manager-agent delegation.

Raw `schema` and `validate` remain an advanced compatibility surface for existing
reviewed scripts. They are not standard authoring output.

Routine failures stay runtime-owned. A failed `agent()`, `parallel()`, or
`pipeline()` fails the run. Do not catch it into partial success unless the
approved design explicitly requires partial results and explains why they remain
useful.

## Delegation limit

An SDK child still cannot call `spawn_agent` or `task`; a read-only child has an
even narrower tool set. Dynamic decomposition therefore stays in the visible
harness: one `agent({ handoffs })` discovers bounded text units and explicit
`parallel()` or `pipeline()` calls process them under the shared workflow budget.
Do not simulate a recursive manager, capability inheritance, or hidden graph with
a large structured plan.

## Build checks

Build writes exactly one `.pi/workflows/<name>.workflow.mjs` matching the approved
design, then checks:

- `meta.name` matches both design and filename;
- source identity policy passes;
- the module loads and exports `meta` plus a default function;
- source exposes the approved nodes, edges, handoffs, bounds, and failure exits;
- no unapproved node or standard-profile bad smell appeared.

Build does not run. The caller runs it separately and evaluates the primary
artifact against live repository evidence.

## Trust boundary

Workflow JavaScript runs in Pi’s main Node.js process with host filesystem,
subprocess, and network authority. Worktrees and approval are evidence and
consent, not a sandbox. Run only reviewed files. Full DSL, trust, replay, and
artifact details: [`../../docs/extensions/active/workflows.md`](../../docs/extensions/active/workflows.md)
and [`../../extensions/workflows/AUTHORING.md`](../../extensions/workflows/AUTHORING.md).
