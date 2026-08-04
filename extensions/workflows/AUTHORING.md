# Authoring a readable pi-workflow

The bundled entry point is
[`skills/locus-pi-workflows/SKILL.md`](../../skills/locus-pi-workflows/SKILL.md).
The complete runtime, trust, replay, and artifact reference is
[`docs/extensions/active/workflows.md`](../../docs/extensions/active/workflows.md).

## Contract: Design, approve, Build

A plain request to create a workflow produces only
`.pi/workflows/<name>.design.md`. The author shows that file to the operator and
stops. Only this exact request kind authorizes source creation:

```text
Build approved design: .pi/workflows/<name>.design.md
```

The Build turn writes the matching `<name>.workflow.mjs`, checks source identity
and module load, and does not run it. A changed algorithm returns to Design for
approval. Approval is never inferred from “create a workflow”, previous chat, or
the existence of a draft. The exact Build command approves the design bytes
present at its path when Build reads them; the protocol has no separate approval
token or stored digest, so review the current file immediately before Build.

Use `/agent run workflow-author` or delegate to the bundled `workflow-author`
catalog agent. A raw request is always Design. The agent’s exact design template
and standard source profile live in its prompt and the skill above.

## What the design must expose

The Markdown draft names:

- purpose, semantic input, and primary output;
- selected pattern;
- numbered algorithm;
- every node’s responsibility, exact input, complete output, capability, and
  consumer;
- edges, concurrency groups, loop bounds, human gates, and failure exits;
- orchestration mechanisms.

Agent count is not a complexity penalty. Hidden machinery is. Count raw schema,
validator, parser, custom retry/recovery, execution wrapper, renderer, hidden
state, loop, judge, and concurrency barrier.

Pattern cards are progressive-disclosure references under
[`skills/locus-pi-workflows/references/`](../../skills/locus-pi-workflows/references/INDEX.md).
They describe algorithms and truthful small snippets, not full scripts to copy.

## Standard primitive profile

`agent()` is the only model-calling primitive. Narrative output is exact text.
When JavaScript must route, use the runtime-owned exact choice:

```js
const route = await agent("Choose the next step.", {
  choice: ["accept", "revise", "blocked"],
});
```

The runtime desugars `choice` to its existing string-enum shape path. It owns
format instructions, parsing, validation, corrective re-ask, journal evidence,
replay, budgets, and fail-closed exhaustion. Workflow code does none of those.

When discovery determines the work units at runtime, use bounded text handoffs:

```js
const units = await agent("Return one complete handoff per discovered unit.", {
  handoffs: { minItems: 1, maxItems: 64, maxItemChars: 4000 },
});
```

Runtime desugars `handoffs` to its bounded unique non-blank string-array path and
owns the same format instructions, repair, replay, journal, budget, and
fail-closed behavior. Workflow code passes each returned string unchanged into
visible `parallel()` or `pipeline()` workers.

The remaining standard orchestration primitives are:

| Primitive                            | Responsibility                                               |
| ------------------------------------ | ------------------------------------------------------------ |
| `parallel(thunks)`                   | One fail-closed barrier over independent author-known calls. |
| `pipeline(items, ...stages)`         | Fixed ordered stages for each author-known item.             |
| `phase(name)` / `log(text)`          | Reader-visible run progress.                                 |
| `publishArtifact(name, text)`        | Supporting exact text artifact.                              |
| `publishPrimaryArtifact(name, text)` | One terminal semantic document.                              |
| `awaitOperator(declaration)`         | Explicit human pause with runtime-owned continuation.        |
| `items()`                            | Immutable exact caller-supplied text units.                  |
| `promptFile(path, variables)`        | Long/shared role charter; never routing.                     |
| `workspace(label, ref)`              | Runtime-owned retained worktree for approved write flows.    |

Trusted raw `schema` and `validate` remain an advanced compatibility surface for
existing workflows. Standard generated source uses only exact text, `choice`,
and `handoffs` answers.

## Target source shape

Keep stable identities together near the top. Keep prompts,
calls, branches, and handoffs visible at their execution edges.

```js
export const meta = {
  name: "review-task",
  description: "Review one task and publish the complete result.",
};

const AGENTS = {
  reviewer: { agent: "reviewer" },
  composer: { agent: "default" },
};

export default async function run({ agent, parallel, phase, publishPrimaryArtifact }, input) {
  phase("review");
  const reviews = await parallel([
    () => agent(`Review the contract:\n${input}`, { ...AGENTS.reviewer, label: "contract-review" }),
    () => agent(`Review the evidence:\n${input}`, { ...AGENTS.reviewer, label: "evidence-review" }),
  ]);

  phase("compose");
  const result = await agent(`Return the complete review:\n${reviews.join("\n\n")}`, {
    ...AGENTS.composer,
    label: "compose-review",
  });
  return publishPrimaryArtifact("review.md", result);
}
```

The workflow orchestrates but does not interpret or format agent results:

- an extraction agent returns the complete textual finding or list;
- a composer returns the complete Markdown document;
- a reviewer returns the complete corrected replacement;
- the script passes these values unchanged and publishes accepted text exactly.

Every child receives the full tool surface through `tools: ["*"]`. Standard
source contains no capability fields or tool lists. Roles choose only
prompt/model identity. `write`, `edit`, `bash`, and every other available tool
work by default.

Filesystem prompts name their location explicitly. Give a reader the exact
`projectRoot()` as `pwd` and require project-relative source paths. Give a writer
the exact `runWorkspaceDir()` or retained `workspace()` path plus the required
relative output filename. Tell the agent not to redirect work into the user's
home directory or `/tmp`. The workflow must not repair location mistakes with a
path parser or an information-gathering script.

Semantic workflow input is not a hidden machine protocol. Standard source does
not split, regex-match, or parse input into branch units. Lists come from one of
three explicit sources: an author-known array, exact caller transport through
`dsl.items()`, or runtime-owned `agent({ handoffs })`. All three feed the same
visible `pipeline(items, ...)` body. Caller items preserve order and exact bytes,
including empty strings and duplicates, with no item-list limits; a workflow
checks only domain rules it truly needs. Model handoffs retain their separate
declared bounds, corrective re-ask, blank rejection, and duplicate rejection.

```js
async function processItem(dsl, item) {
  const finding = await dsl.agent(`Inspect this unit:\n${item}`, { label: `inspect:${item}` });
  return dsl.agent(`Write the result:\n${item}\n\n${finding}`, { label: `write:${item}` });
}

export default function runWorkflow(dsl) {
  const items = dsl.items(); // Or a file-top array, or await dsl.agent(..., { handoffs }).
  if (items.length === 0) throw new Error("this workflow requires at least one work item");
  return dsl.pipeline(items, (item) => dsl.workflow((nested) => processItem(nested, item)));
}
```

`dsl.workflow()` is an inline readability/journal boundary. It starts no saved
workflow, child run, budget, workspace, or permission scope. The item appears
only in prompts that explicitly use it; the runtime does not copy the full list
into child metadata.

## Standard-profile bad smells

Do not generate:

- domain schemas, `validate`, input splitting, JSON/prose parsers, regex gates,
  coverage checks;
- Markdown/table/report renderers or handoff formatters;
- hand-written retry loops, branch-local `try/catch`, custom partial-result or
  failure envelopes;
- wrappers, registries, or graph engines around `agent()`;
- agents declared as personas with no distinct subtask inputs, outputs, and edges;
- prompt files that hide routing;
- domain-specific helpers promoted into runtime;
- a large structured plan used to fake manager-agent delegation.

This list is a baseline, not a loophole. During review, ask whether any helper
interprets, grades, reformats, recovers, or hides an agent edge. If yes, move the
semantic work into an agent, use a generic runtime guarantee, or return to design.

Routine agent and group failure is uncaught and fail-closed. Partial continuation
is outside the standard profile unless the approved design explicitly proves
that surviving results remain useful.

## Dynamic decomposition without manager delegation

The host reserves the recursive `spawn_agent` and `task` entrypoints; this is a
system-owned recursion boundary, not an author-managed allowlist. Keep dynamic
decomposition in the visible harness instead:
one `agent({ handoffs })` discovers bounded text units, then explicit
`parallel()` or `pipeline()` calls process them under the shared workflow budget.
Recursive manager delegation and capability inheritance remain unsupported; do
not recreate them with a structured planner and JavaScript dispatcher.

## Saved module and identity

A built workflow is one ESM module:

```js
export const meta = { name: "<name>", description: "<one line>" };
export default async function runWorkflow(dsl, input) {
  // use only the dsl members the approved graph needs
}
```

The filename is exactly `<name>.workflow.mjs`. `.pi/workflows/` is the canonical
project target. The default `self-contained-static` identity accepts only static
`node:` imports and runs the retained snapshot. Local, package, or dynamic
imports require literal `meta.identityCoverage: "entry-only"`, which binds only
entry bytes. The analyzer cannot infer arbitrary eval or `createRequire` aliases;
declare the downgrade honestly.

Before handoff, run `assessWorkflowSourceIdentity()` against exact source bytes,
then import the module and require `meta.name` plus a default function. Static
validation is not evidence that the workflow ran.

## Input, artifacts, and failure

`input` is optional bounded semantic text, not a command language or serialized
object. Programmatic callers may separately supply exact `items: string[]`;
`dsl.items()` exposes a frozen snapshot and returns an empty frozen list when
absent. The human `/workflows run` grammar is unchanged. Cross-run data arrives
through host-verified continuation artifacts.
`agent({ artifact })` names the runtime-captured exact answer;
`publishPrimaryArtifact()` declares the one successful terminal document.

`parallel()` and `pipeline()` wait for scheduled siblings and then reject on a
failed branch. Invocation cap, timeout, inherited tool access, answer
bounds, transport retry policy, artifact integrity, continuation, operator
approval, and replay are runtime responsibilities. The package-wide
`totalAgents` fuse defaults to 10,000: enough for fine-grained finite
decomposition, while the next physical attempt still fails a runaway run.

## Trust boundary

Workflow JavaScript is reviewed trusted local code executed in Pi’s main Node.js
process with filesystem, subprocess, and network authority. A worktree isolates
changes for review; it is not a security sandbox. Pi exec approval records
consent; it does not remove capabilities. Run only files you have read.
