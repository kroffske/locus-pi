---
name: locus-pi-workflow-create
description: Create or revise an orchestration-only locus-pi `.workflow.mjs` agent graph through Design, review, Build, and source validation. Generated source contains prompts and agent/DSL edges, not file-reading logic. Never run the workflow.
---

# Create a locus-pi workflow

A workflow is reviewed trusted JavaScript that makes a visible graph of child
`agent()` calls. Workflow source is orchestration only: author-known prompts,
direct agent/DSL calls, visible control flow, exact handoffs, and text
publication. It never reads project files, prompt files, or prior artifacts.
Agents own interpretation, any source inspection requested by their prompt, and
complete reader-facing text.

This skill owns authoring only. For running, starting, resuming, or monitoring
the current run of an existing workflow, use the shipped
`locus-pi-workflow-run` skill.
Do not use merely to run an existing workflow.

## Ownership

Follow this skill directly in the current agent session. The workflow extension
owns this protocol; no package-provided catalog agent is required. A successful
create operation ends after Design review, Build, and `workflow_check_source`;
it does not run the new workflow.

## Authoring is continuous by default

A plain request to create, design, write, or author a workflow runs one visible
sequence in the same turn:

1. Create `.pi/workflows/<name>/` and write
   `.pi/workflows/<name>/<name>.design.md` before any source.
2. Review the design against the request, selected pattern, graph contract, and
   standard source profile. Revise the design until the review finds no material
   mismatch.
3. Build exactly the direct `.workflow.mjs` entries declared by the reviewed
   design. A `runnable root` design includes
   `.pi/workflows/<name>/<name>.workflow.mjs`; a `group-only` design omits it
   and builds only its direct children. Never invent a root.
4. Validate source identity, module load, graph correspondence, and standard
   source shape. Do not run the workflow unless the user separately asks to run it.

The design remains the readable source of truth and must exist before JavaScript;
continuous authoring removes only the mandatory human pause between them. Stop
after the design only when the user explicitly asks for `design only`, `pause
after design`, `do not build`, or equivalent wording. A user may also request the
build-only compatibility route with `Build approved design: <exact design path>`
or `Build design: <exact design path>`.

If design review or Build discovers a material algorithm mismatch, update and
re-review the design before
building; never hide the change in source. Ask the user only when resolving the
mismatch would change the requested result, not for routine authoring choices.

An owner-approved `plan.md` plus its canonical `step-<n>.md` catalog may be
authoring input for an optional sequential project-local workflow. Read
[`references/plan-to-sequential-workflow.md`](./references/plan-to-sequential-workflow.md).
Preserve every complete task block: Build renders those blocks as literal
author-known prompts in generated source, or uses caller `items` only when a
programmatic embedder owns the frozen list. Plan approval alone does not start
workflow authoring; once the user requests that workflow, the ordinary continuous
design -> review -> build sequence applies unless they explicitly request design only.

The Package child `task/implement-plan-template` owns the fixed sequential
renderer. After the owner approves `task/plan`, it reads that same workspace and
renders `implement-plan.workflow.mjs` — one literal implementation node per
`step-<n>.md` file, then a summary node. It never plans or replans. That file is
an unregistered draft that resolves only by explicit path, and the owner reviews
it before running it. `task/substep` is the separate manual one-step worker. Use
Design and Build for a graph the fixed template cannot express, such as a
reviewer between steps, a bounded revision loop, or concurrency.

## Design contract

The design is short Markdown a reader can approve without opening JavaScript:

```markdown
# Design: <name>

Purpose: <one sentence>
Input: <semantic text or none>
Primary output: `<name>.md`
Evidence boundary: <semantic input, caller items, author-known prompt material, or child inspection>
Pattern: <catalog pattern, or why none fits>

Namespace: `runnable root` (include the `<name>` entry below) or `group-only`
(omit the root entry; children remain directly runnable)

## Entries

| Ref              | Entry kind    | Responsibility         | Invoked by |
| ---------------- | ------------- | ---------------------- | ---------- |
| `<name>`         | runnable root | <standard entry point> | operator   |
| `<name>/<child>` | direct child  | <one bounded subtask>  | `<node>`   |

For `group-only`, omit the `<name>` row entirely. Declare every direct child
that Build must create; do not declare grandchildren or an implicit root.

1. <numbered algorithm>

| Node     | Responsibility         | Receives      | Returns                              | Next       |
| -------- | ---------------------- | ------------- | ------------------------------------ | ---------- |
| `<node>` | <one coherent subtask> | <exact input> | <complete text, choice, or handoffs> | <consumer> |

Concurrency: <groups or none>
Loop bounds: <bounds or none>
File boundary: workflow source performs no file reads; name any child-owned source inspection
Worst-case calls: <exact formula including saved children>
Failure exits: <fail-closed exits>
Mechanisms: <parallel barriers, choices, loops, human gates; no agent-count penalty>
Status: REVIEWED — ready for build.
```

Count orchestration machinery, not agents. More agents are fine when the task
really decomposes into more coherent subtasks.

Read [`references/INDEX.md`](./references/INDEX.md), then only the selected
pattern card. The cards are algorithms and small snippets, not full workflows to
copy blindly.

## Standard source profile

Declare stable stage option groups together near the top. Keep every prompt,
call, branch, and exact handoff visible where it executes. Stage prompts own
their roles; do not depend on package-provided agent names.
Declare `meta.profile: "standard"` in every newly generated workflow.
`meta.phases` is optional. When Design chooses to expose it, declare every
unique literal `phase("...")` id exactly once and in first-source order. Case
drift, duplicate declarations, and missing ids fail source checking; unused
declarations and order drift are warnings.

New source from this skill uses the orchestration-only subset of the standard
profile. It may call `agent`, `parallel`, `pipeline`, `workflow`,
`invokeWorkflow`, `items`, `phase`, `log`, `awaitOperator`, `publishArtifact`,
and `publishPrimaryArtifact`. It may use the runtime-owned `choice` and
`handoffs` agent options. Do not generate `consumeTextArtifact`,
`continuationArtifacts`, `outputDir`, `projectRoot`, `promptFile`,
`publishPrimaryFile`, `workspace`, `now`, or `random`. Those compatibility
primitives turn the workflow script into a file, host-state, or policy engine.
Build calls `workflow_check_source` with `mode: "orchestration-only"`. The
strict mode rejects any source outside this authoring subset. Never use the
default compatibility mode for a newly generated workflow.

Omit `maxToolCalls` and `timeoutMs` from standard generated `agent()` options.
The package already applies emergency defaults to every child attempt. Emit a
per-attempt override only when the operator explicitly requests a narrower or
raised fuse and the approved Design records why. Do not sweep legacy workflows.

```js
const AGENTS = {
  reviewer: {},
  composer: {},
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
per known item; `awaitOperator()` declares a human gate. Long charters remain
literal prompts in reviewed source instead of hidden prompt-file reads.

Every workflow child receives the full tool surface through `tools: ["*"]`.
Standard source contains no capability fields or tool lists. Roles choose only
prompt/model identity. `write`, `edit`, `bash`, and every other available tool
work by default. When the task needs repository evidence, tell the child to
inspect it in the prompt. The workflow JavaScript never obtains project paths or
artifact contents and never performs that inspection itself.

Workflow `input` remains semantic text. A main agent that already knows exact
work units passes them separately as `workflow({ name, input, items })`; workflow
source reads the immutable list with `dsl.items()`. Values, order, whitespace,
empty strings, and duplicates are preserved with no Locus items count or
character policy,
so source enforces only its real domain rule, such as requiring at least one item.
Standard source does not encode a hidden line/CSV/JSON protocol. It does not
`split`, regex-match, or parse semantic input into branch units. Author-known arrays, caller-supplied
`dsl.items()`, and bounded model-discovered `agent({ handoffs })` lists all feed
the same visible `pipeline(items, ...)`; model handoffs alone retain runtime
repair, blank/duplicate rejection, and declared bounds.

Use `invokeWorkflow({ child: "<declared-sibling>", ... })` only when the reviewed
graph genuinely needs a separate saved child run. The call is still an
orchestration edge. Do not add workspace paths, artifact reads, checkpoint
parsers, or synthetic success documents around it. Prefer direct `agent()`
handoffs when the parent must consume the child's text.

Fresh model discovery stays in the visible non-resumable
`agent({ handoffs }) -> parallel()/pipeline()` pattern. Never turn discovered
text into file-backed transport or workflow-side checkpoint logic.

Run evidence remains runtime-owned. Workflow source passes text and control
values only. If a child reads or writes files because its prompt requires that
work, the child owns the operation and returns a complete textual handoff; the
orchestrator does not collect, parse, verify, or publish those files.

## Forbidden in standard generated source

The machine-enforced compatibility grammar is
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

The compatibility grammar is broader because it still validates existing
reviewed scripts. Do not copy that broader method list into new source. For this
skill, Build applies the orchestration-only subset above after the machine check.

- raw `schema` or `validate`;
- input splitting, JSON/prose parsers, regex gates, coverage assertions, or
  domain validators;
- Markdown/table/report renderers;
- hand-written retries, broad `try/catch`, partial-result envelopes, or custom
  failure recovery;
- wrappers or registries around `agent()` that hide prompts and edges;
- file or host-state DSL calls, file reads, imports, path discovery, artifact
  consumption, or workflow-side file verification;
- domain-specific runtime helpers;
- a large structured plan used to fake manager-agent delegation.

Raw `schema` and `validate` remain an advanced compatibility surface for existing
reviewed scripts. They are not standard authoring output.

Routine failures stay runtime-owned. A failed `agent()`, `parallel()`, or
`pipeline()` fails the run. Do not catch it into partial success unless the
approved design explicitly requires partial results and explains why they remain
useful. Root returns and direct `parallel()`/`pipeline()` returns share one
semantic failure contract: `ok === false`, `partial === true`, or
`status: "failed" | "blocked" | "cancelled"`. Do not rely on one returned
object meaning success in one orchestration context and failure in another.

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

Build writes one canonical folder matching the reviewed design: an optional
`.pi/workflows/<name>/<name>.workflow.mjs` only when the namespace is declared
`runnable root`, plus only its declared direct child entries. A `group-only`
namespace has no root source and never receives a fake one. It then checks:

- the design `Entries` table and source set match exactly;
- when present, root `meta.name` equals `<name>`; each child `meta.name` equals
  `<name>/<child>` and its filename is `<child>.workflow.mjs`;
- `meta.profile` is `"standard"`;
- source identity policy passes;
- the module loads and exports `meta` plus a default function;
- source exposes the reviewed nodes, edges, handoffs, bounds, and failure exits;
- no design-absent node or standard-profile bad smell appeared.
- the exact built file passes the Pi-native `workflow_check_source` tool with
  `mode: "orchestration-only"` for every built
  `.pi/workflows/<name>/*.workflow.mjs` path.
- every built source uses only the orchestration-only DSL subset and contains no
  file, path, artifact-consumption, clock, or randomness primitive.

Read checker diagnostics as `path:line:column [CODE] message`. Any error fails
Build. Warning-only output remains a successful check, but Build must report the
warning and repair declaration drift when it concerns generated source.

An unavailable tool, failed checker result, failed module import, or
design/source mismatch means Build failed. Repair and rerun; never return a
successful Build claim after a skipped or failed check.

Build does not run. The caller runs it separately and evaluates the primary
artifact against live repository evidence. A successful Build returns the exact
copyable launch command `/workflows run <name>` (or the qualified child ref).

## Trust boundary

Workflow JavaScript runs in Pi’s main Node.js process with host filesystem,
subprocess, and network authority. Worktrees and approval are evidence and
consent, not a sandbox. Run only reviewed files. Full DSL, trust, replay, and
artifact details: [`../../extensions/workflows/REFERENCE.md`](../../extensions/workflows/REFERENCE.md)
and [`../../extensions/workflows/AUTHORING.md`](../../extensions/workflows/AUTHORING.md).
