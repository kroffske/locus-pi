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
`.pi/locus-pi/runs/<runId>/`; `outputs/` contains the human projection and
`runtime/result.json` contains the terminal envelope. Agent-authored files are
separate, under the workflow workspace described below.

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

An owner-approved `plan.md` plus its canonical `steps.md` may be Design input for an
optional sequential project-local workflow. Read
[`references/plan-to-sequential-workflow.md`](./references/plan-to-sequential-workflow.md).
Preserve every complete task block: Build renders those blocks as literal
author-known prompts in generated source, or uses caller `items` only when a
programmatic embedder owns the frozen list. Plan approval never implies workflow
Build approval.

The Package `plan` workflow already renders `execute.workflow.mjs` into its own
workflow workspace from a fixed template — one literal implementation node per
`## S<n>` block, then a summary node. That file is an unregistered draft that
resolves only by explicit path, and the owner reviews it before running it. Use
Design and Build for a graph the fixed template cannot express, such as a
reviewer between steps, a bounded revision loop, or concurrency.

## Design contract

The design is short Markdown a reader can approve without opening JavaScript:

```markdown
# Design: <name>

Purpose: <one sentence>
Input: <semantic text or none>
Primary output: `<name>.md`
Workflow workspace: `<pwd>/tmp/<name>` by default, or <explicit project-relative directory>
Pattern: <catalog pattern, or why none fits>

1. <numbered algorithm>

| Node     | Responsibility         | Receives      | Returns                              | Next       |
| -------- | ---------------------- | ------------- | ------------------------------------ | ---------- |
| `<node>` | <one coherent subtask> | <exact input> | <complete text, choice, or handoffs> | <consumer> |

Concurrency: <groups or none>
Loop bounds: <bounds or none>
Durable items: <complete key source, or none>
Idempotence: <how each assigned file is replaced safely>
Project source: <live-read drift policy>
Worst-case calls: <exact formula including saved children>
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

Declare stable agent identities together near the top. Keep
every prompt, call, branch, and exact handoff visible where it executes.
Declare `meta.profile: "standard"` in every newly generated workflow.

Omit `maxToolCalls` and `timeoutMs` from standard generated `agent()` options.
The package already applies emergency defaults to every child attempt. Emit a
per-attempt override only when the operator explicitly requests a narrower or
raised fuse and the approved Design records why. Do not sweep legacy workflows.

```js
const AGENTS = {
  reviewer: { agent: "reviewer" },
  composer: { agent: "default" },
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
  parsing, validation, journal evidence, and replay. Exhaustion fails closed unless
  the approved Design names `choiceFallback` as one of those choices; runtime uses
  that degraded route only after both invalid answers and journals why.
- `handoffs`. Use `agent(prompt, { handoffs: { maxItems: MAX_DAGS_IN_SCOPE } })`
  when one discovery call must return a small bounded runtime list of complete
  text work units. The approved Design derives and names the bound from the
  domain; it is transport safety, not a default business limit. Runtime requires
  `maxItems` in `1..100` and owns the array shape, blank/duplicate rejection, one
  repair, replay, and fail-closed exhaustion. Workflow code receives `string[]`
  and uses `parallel()` or `pipeline()`.

`agent()` is the only model-calling primitive. `parallel()` is the fail-closed
barrier for independent known calls; `pipeline()` handles fixed ordered stages
per known item; `awaitOperator()` declares a human gate; `promptFile()` may hold
a long charter but never hide routing.

Every workflow child receives the full tool surface through `tools: ["*"]`.
Standard source contains no capability fields or tool lists. Roles choose only
prompt/model identity. `write`, `edit`, `bash`, and every other available tool
work by default.

The runtime injects one exact absolute workflow workspace into every child
prompt. It defaults to `<pwd>/tmp/<workflow-name>/`, where `pwd` is Pi's verified
session working directory inside the project. Name the assigned relative file
and tell writers to replace it idempotently. Use `projectRoot()` only when an
agent needs source context. Do not add JavaScript path parsers, directory
collectors, permission fields, or alternate writable roots.

Workflow `input` remains semantic text. A main agent that already knows exact
work units passes them separately as `workflow({ name, input, items, outputDir })`; workflow
source reads the immutable list with `dsl.items()`. Values, order, whitespace,
empty strings, and duplicates are preserved with no Locus items count or
character policy,
so source enforces only its real domain rule, such as requiring at least one item.
Standard source does not encode a hidden line/CSV/JSON protocol. It does not
`split`, regex-match, or parse semantic input into branch units. Author-known arrays, caller-supplied
`dsl.items()`, and bounded model-discovered `agent({ handoffs })` lists all feed
the same visible `pipeline(items, ...)`; model handoffs alone retain runtime
repair, blank/duplicate rejection, and declared bounds.

For durable work, use a real saved mini workflow for each caller-frozen item.
Pass the complete key list so the runtime validates every key before the first
child starts:

```js
const items = dsl.items();
const keys = items.map((_, keyIndex) => `item-${keyIndex + 1}`);
for (let index = 0; index < items.length; index += 1) {
  const item = items[index];
  await dsl.invokeWorkflow({
    name: "saved-worker",
    key: keys[index],
    keys,
    input: item,
    items: [item],
    outputDir: dsl.outputDir(),
  });
}
return dsl.publishPrimaryFile("report.md");
```

Keys are stable compact identities, not semantic payload. Prefer caller-owned
semantic keys. Position keys are safe only when the caller intentionally reuses
the exact same approved item list and ordering for the same output namespace;
pass item text unchanged as child input.

Fresh model discovery stays in the non-resumable inline
`agent({ handoffs }) -> parallel()/pipeline()` pattern. To make discovered work
durable, finish that discovery run, expose the list for human approval, then let
a separate caller pass the frozen list and stable keys to the durable parent.
Never derive resumable positional keys from fresh model output.

`invokeWorkflow()` starts a real depth-one saved run with its own evidence and
lineage. It shares root cancellation, concurrency, workflow workspace, and
the 10,000 physical-agent-call fuse. Matching completed-item checkpoints skip
work on retry; parent or child source changes invalidate them. Saved children
cannot nest, and source cycles fail before model work.

Run evidence remains under `.pi/locus-pi/runs/<runId>/` and contains only
`outputs/` plus `runtime/`. Durable user files belong under the project-local
workspace returned by `dsl.outputDir()`, defaulting to
`<pwd>/tmp/<workflow-name>/`. Tell writers to replace their assigned relative
file idempotently and never create workflow artifacts in the project root.
`publishPrimaryFile()` returns a host-validated path, byte count, and digest for
one regular non-empty file. Workspace files survive failed runs. Project source is
read live; record a drift policy in the approved design instead of building a
workflow-side snapshot, ledger, parser, or recovery layer.

## Forbidden in standard generated source

The exhaustive machine-enforced grammar is
[`../../extensions/workflows/AUTHORING.md`](../../extensions/workflows/AUTHORING.md#machine-enforced-standard-source-shape).
It closes the module to literal metadata/constants plus one visible run export,
forbids every import, permits only direct bound DSL calls plus visible collection
mapping/prompt joining and the documented input-default ternary, restricts
statements and mutation, removes helpers/policy wrappers, and prevents lexical
shadowing of trusted DSL, collection, and `Error` bindings. Bare and
parenthesized arrow parameters are checked identically. Only the first run
parameter supplies DSL trust. Semantic input, plain agent text, and item aliases
remain opaque whole values; choices, list identity/status, and counters are the
machine-consumed control values. Give every semantic or runtime-owned
value-bearing binding one globally unique name, including map/pipeline
parameters and loop counters. A nested scalar literal may reuse the spelling
without changing the outer value's provenance. Use only declared lexical or
literal roots: ambient host globals and implicit `arguments` are outside the
standard profile. Arrays, objects, spreads, and nested composites retain the
provenance of every contained semantic/runtime value. Inline callbacks use
arrows, not function expressions. Sequence expressions are outside the grammar,
including literal-only sequences. Construct `Error` only from author-known or
literal arguments; nesting a semantic/runtime value inside its message, options,
cause, arrays, objects, spreads, or member access remains forbidden.

Return provenance is exhaustive: exact `agent({ choice })` identity, list results
(`agent({ handoffs })`, `continuationArtifacts`, `items`, `parallel`, `pipeline`),
and `invokeWorkflow().status` are the only control categories. Ordinary `agent`,
`consumeTextArtifact`, `promptFile`, `workflow`, and `workspace` are opaque.
`now`, `random`, both host path calls, and all three publication calls are
runtime/host values. `awaitOperator`, `log`, and `phase` are void effects and may
not be used as values. Opaque/runtime-host values flow only whole through the
documented sinks; only `outputDir()` may flow unchanged to
`invokeWorkflow.outputDir`.

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

The host still reserves the recursive `spawn_agent` and `task` entrypoints; this
is one system-owned recursion boundary, not a tool list workflow authors manage.
Dynamic decomposition therefore stays in the visible harness: caller-supplied
`dsl.items()` or one `agent({ handoffs })` supplies text units, and explicit
`parallel()` or `pipeline()` calls process them under the shared workflow budget.
The default `totalAgents` fuse is 10,000 so fine-grained finite decomposition has
headroom; exceeding it still fails the run as a genuine runaway loop.
The package defaults are 1,000 tool calls, a 24-hour timeout, 20 turns, and
500,000 answer characters per child attempt; one run admits at most 10,000
physical attempts, starts no new child after its 24-hour gate, and runs at most
four attempts concurrently. Review and retry attempts consume `totalAgents`.
The SDK timeout is a later transport backstop, not authored policy. Use natural
task evidence, not a fixed one-word
acknowledgement protocol. Build review rejects a mandatory acknowledgement whose
answer has no consumer; the structural checker deliberately does not parse
prompt English to guess that intent.
Do not simulate a recursive manager, capability inheritance, or hidden graph with
a large structured plan.

## Build checks

Build writes exactly one `.pi/workflows/<name>.workflow.mjs` matching the approved
design, then checks:

- `meta.name` matches both design and filename;
- `meta.profile` is `"standard"`;
- source identity policy passes;
- the module loads and exports `meta` plus a default function;
- source exposes the approved nodes, edges, handoffs, bounds, and failure exits;
- no unapproved node or standard-profile bad smell appeared.
- `npx @kroffske/locus-pi check-workflow-source
.pi/workflows/<name>.workflow.mjs` reports no standard source-shape violations
  from the project containing the built file.

Build does not run. The caller runs it separately and evaluates the primary
artifact against live repository evidence.

## Trust boundary

Workflow JavaScript runs in Pi’s main Node.js process with host filesystem,
subprocess, and network authority. Worktrees and approval are evidence and
consent, not a sandbox. Run only reviewed files. Full DSL, trust, replay, and
artifact details: [`../../docs/extensions/active/workflows.md`](../../docs/extensions/active/workflows.md)
and [`../../extensions/workflows/AUTHORING.md`](../../extensions/workflows/AUTHORING.md).
