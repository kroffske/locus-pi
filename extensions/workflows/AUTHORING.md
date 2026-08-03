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
  tools: [],
  maxToolCalls: 0,
});
```

The runtime desugars `choice` to its existing string-enum shape path. It owns
format instructions, parsing, validation, corrective re-ask, journal evidence,
replay, budgets, and fail-closed exhaustion. Workflow code does none of those.

The remaining standard orchestration primitives are:

| Primitive                            | Responsibility                                               |
| ------------------------------------ | ------------------------------------------------------------ |
| `parallel(thunks)`                   | One fail-closed barrier over independent author-known calls. |
| `pipeline(items, ...stages)`         | Fixed ordered stages for each author-known item.             |
| `phase(name)` / `log(text)`          | Reader-visible run progress.                                 |
| `publishArtifact(name, text)`        | Supporting exact text artifact.                              |
| `publishPrimaryArtifact(name, text)` | One terminal semantic document.                              |
| `awaitOperator(declaration)`         | Explicit human pause with runtime-owned continuation.        |
| `promptFile(path, variables)`        | Long/shared role charter; never routing.                     |
| `workspace(label, ref)`              | Runtime-owned retained worktree for approved write flows.    |

Trusted raw `schema` and `validate` remain an advanced compatibility surface for
existing workflows. Standard generated source uses only exact text and `choice`
answers.

## Target source shape

Keep stable identities and capabilities together near the top. Keep prompts,
calls, branches, and handoffs visible at their execution edges.

```js
export const meta = {
  name: "review-task",
  description: "Review one task and publish the complete result.",
};

const AGENTS = {
  reviewer: { agent: "reviewer", readOnly: true },
  composer: { tools: [], maxToolCalls: 0 },
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

Semantic workflow input is not a hidden machine protocol. Standard source does
not split, regex-match, or parse input into branch units. `parallel()` and
`pipeline()` operate over units named in the approved graph. Runtime-discovered
units require an agent-authored textual handoff or an honest unsupported-gap
report, not an input parser plus dynamic dispatch.

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

## Unsupported dynamic manager delegation

SDK children cannot call `spawn_agent` or `task`; read-only children have a
stricter tool set. Therefore a manager child cannot safely discover arbitrary
units and delegate them under a shared budget today. Use explicit `parallel()`
over units named in the approved design, let one agent inspect all units, split
the job across workflows, or stop and name the missing first-class primitive.
Do not recreate it with a structured planner and JavaScript dispatcher.

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
object. Cross-run data arrives through host-verified continuation artifacts.
`agent({ artifact })` names the runtime-captured exact answer;
`publishPrimaryArtifact()` declares the one successful terminal document.

`parallel()` and `pipeline()` wait for scheduled siblings and then reject on a
failed branch. Invocation cap, timeout, permissions, read-only policy, answer
bounds, transport retry policy, artifact integrity, continuation, operator
approval, and replay are runtime responsibilities.

## Trust boundary

Workflow JavaScript is reviewed trusted local code executed in Pi’s main Node.js
process with filesystem, subprocess, and network authority. A worktree isolates
changes for review; it is not a security sandbox. Pi exec approval records
consent; it does not remove capabilities. Run only files you have read.
