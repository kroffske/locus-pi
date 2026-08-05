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
- every node’s responsibility, exact input, complete output, role, and
  consumer;
- edges, concurrency groups, loop bounds, human gates, and failure exits;
- workflow workspace, complete durable item-key source, idempotent file-update
  rule, and project-source drift policy;
- worst-case physical call count, including saved child runs;
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
| `outputDir()`                        | Project-relative workflow workspace selected by the host.    |
| `invokeWorkflow(declaration)`        | One real saved child run with durable item checkpointing.    |
| `publishPrimaryFile(path)`           | Validate/reference one non-empty workflow workspace file.    |
| `promptFile(path, variables)`        | Long/shared role charter; never routing.                     |
| `workspace(label, ref)`              | Runtime-owned retained worktree for approved write flows.    |

`runWorkspaceDir()` is removed. Existing source that calls it fails with
`WorkflowRunWorkspaceRemovedError`; migrate to `outputDir()` and the single
project-local workflow workspace. The runtime does not create a run-local
`workspace/` directory.

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
  profile: "standard",
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

The runtime prepends one exact absolute workflow workspace to every child
prompt. It defaults to `<pwd>/tmp/<workflow-name>/`, where `pwd` is Pi's verified
session working directory inside the project. Source may call `outputDir()` when
it needs the project-relative identity, but authors should only need to name the
assigned relative file and the idempotent replacement rule. Use `projectRoot()`
for source context. Do not add permission/tool fields, another default writable
root, a path parser, or an information-gathering script.

Semantic workflow input is not a hidden machine protocol. Standard source does
not split, regex-match, or parse input into branch units. Lists come from one of
three explicit sources: an author-known array, exact caller transport through
`dsl.items()`, or runtime-owned `agent({ handoffs })`. All three feed the same
visible `pipeline(items, ...)` body. Caller items preserve order and exact bytes,
including empty strings and duplicates, with no item-list limits; a workflow
checks only domain rules it truly needs. Model handoffs retain their separate
declared bounds, corrective re-ask, blank rejection, and duplicate rejection.

For durable item work, start from a caller-frozen approved list. The parent then
invokes one reviewed saved child per key and passes that same full list on every
call, allowing the host to reject duplicate or unsafe keys before the first
child starts:

```js
export const meta = {
  name: "durable-parent",
  description: "Run one saved worker per exact caller item.",
  profile: "standard",
};

export default async function runWorkflow(dsl) {
  const items = dsl.items();
  if (items.length === 0) throw new Error("this workflow requires at least one work item");
  const keys = items.map((_, keyIndex) => `item-${keyIndex + 1}`);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await dsl.invokeWorkflow({
      name: "durable-worker",
      key: keys[index],
      keys,
      input: item,
      items: [item],
      outputDir: dsl.outputDir(),
    });
  }
  return dsl.publishPrimaryFile("report.md");
}
```

The child is a real depth-one saved run with its own run directory, source
snapshot, journal, result envelope, and lineage. It shares root cancellation,
global concurrency, the 10,000 physical-agent-call fuse, and the workflow
workspace. A saved child cannot invoke another saved child, and source-identity
cycles fail before agent work. `dsl.workflow()` remains only an inline
readability/journal boundary; it starts no child run or checkpoint.
Keys are compact stable identities, not opaque item payloads. Prefer stable
caller-owned semantic keys. Position keys such as `item-1` are safe only when
the exact approved caller list and ordering are intentionally unchanged for the
reused output namespace. Pass original text unchanged in `input`/`items`; the
runtime never parses it.

A fresh `agent({ handoffs })` list stays in the same-run, non-resumable inline
worker pattern. Durable discovery is two runs: discovery first exposes a
human-readable list for approval, then a separate caller supplies that frozen
list and its stable identities to the durable parent. Never derive resumable
positional keys from fresh model output, and never parse a discovery document as
transport.

The workflow workspace is distinct from run evidence. Its default is
`<pwd>/tmp/<workflow-name>/`; callers may select another safe project-relative
`outputDir`. Every child receives the resolved absolute path once. Writers
replace their assigned file atomically or otherwise idempotently—never append blindly.
`publishPrimaryFile(relativePath)` validates one regular, non-symlink, non-empty
file under that root and returns its path, byte count, and SHA-256 digest without
copying or interpreting the content. Failed runs leave workspace files intact for
inspection and retry.

Completed-item checkpoints are keyed by parent source hash, child source hash,
workflow workspace, and exact item key. A matching checkpoint skips that
child on retry; any source change invalidates it. This is at-least-once
execution, so file writes must remain idempotent. One fenced root lease excludes
concurrent runs using the same stable namespace and prevents a stale owner from
committing after takeover.

Project files are live during a run. The runtime journals that policy and the
run boundary; it does not snapshot the repository or infer domain meaning from
project files. If source consistency matters, the approved design must choose a
generic policy such as fail on detected drift or accept live reads and record
that decision. Do not add a workflow-side ledger, discovery-document parser, or
recovery engine.

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

## Machine-enforced standard source shape

The build gate is deliberately a small source grammar, not a second workflow
engine. For a project workflow, run it against the exact file Build produced:

```bash
npx @kroffske/locus-pi check-workflow-source .pi/workflows/<name>.workflow.mjs
```

This installed-package command resolves the path from the project where it is
run; it needs neither a consumer npm script nor `tsx`. The package ships a
prebuilt ESM checker so Node never has to strip TypeScript under `node_modules`.
Repository maintainers use `npm run check:workflow-source` with no path to check every `standard` entry
already present in the six-workflow Package registry. Neither command discovers
or adds registry entries. The repository-wide `npm run check` gate runs that
Package check. Source-shape validation does not replace source-identity
assessment or importing the module.

These are all rules enforced for `meta.profile: "standard"`:

- Source must parse as JavaScript. The module has exactly one literal
  `export const meta` whose profile is
  `"standard"`, plus exactly one visible default function or arrow export. A
  named entry is `run` or `runWorkflow`. Other top-level declarations are
  `const` values made only from literal arrays, objects, scalars, and static
  strings; comments and a hashbang are harmless, but there are no other
  statements or exports.
- Standard source has no static import, re-export, dynamic `import()`, or
  `require()` call, including `node:` modules. This is stricter than the general
  source-identity policy described below.
- Run bodies use only lexical declarations, expressions, `if`, `switch`,
  `for`, `for…of`/`for…in`, `while`, `break`, `continue`, `return`, `throw`, and
  empty statements. Labels, `do…while`, and other statement forms are outside
  this profile.
- Calls are direct uses of the bound DSL primitives: `agent`, `awaitOperator`,
  `consumeTextArtifact`, `continuationArtifacts`, `invokeWorkflow`, `items`,
  `log`, `now`, `outputDir`, `parallel`, `phase`, `pipeline`, `projectRoot`,
  `promptFile`, `publishArtifact`, `publishPrimaryArtifact`,
  `publishPrimaryFile`, `random`, `workflow`, and
  `workspace`. Computed calls, aliases, `.bind()` wrappers, unknown globals,
  and other method calls are rejected.
- Every allowed DSL call has one exhaustive return classification:

  | Classification     | DSL calls                                                                                                      |
  | ------------------ | -------------------------------------------------------------------------------------------------------------- |
  | Runtime control    | `agent({ choice })` exact identity only                                                                        |
  | Opaque list        | `agent({ handoffs })`, `continuationArtifacts`, `items`, `parallel`, `pipeline`                                |
  | Saved-child status | `invokeWorkflow`; only its exact `status` identity is control                                                  |
  | Opaque value       | ordinary/model `agent`, `consumeTextArtifact`, `promptFile`, `workflow`, `workspace`                           |
  | Runtime/host value | `now`, `random`, `outputDir`, `projectRoot`, `publishArtifact`, `publishPrimaryArtifact`, `publishPrimaryFile` |
  | Void               | `awaitOperator`, `log`, `phase`                                                                                |

  Adding an allowed method without a return category fails closed. Only runtime
  choice, list identity/length, and saved-child status are control primitives.
  Opaque and runtime/host values may be forwarded whole through documented
  prompt, log, publication, scheduling, and return sinks, but may not be
  inspected, branched on, indexed, transformed, or embedded in `Error`.
  `outputDir()` may flow unchanged into `invokeWorkflow.outputDir`. Publication
  references and host paths may flow whole into an agent/log/return. Void calls
  are standalone effects and cannot be bound, nested, or returned as values.

- Only the first run parameter supplies DSL bindings. The second parameter is
  semantic input, never another DSL object.
- Every value read by standard source resolves to a declared lexical/literal
  binding or the approved `Error` language root. Ambient host values and hidden
  environment input are unavailable. The implicit function `arguments` object
  is rejected; run and callback values use explicit named parameters.
- The only extra collection calls are a visible `.map(callback)` over an array
  or a source-ordered binding derived from an array or collection-producing DSL
  call, and `.join()` used inside an `agent()` prompt template. The only extra
  string call is the exact boundary default
  `typeof input === "string" && input.trim() ? input.trim() : "literal"`.
- Inline callbacks use arrow functions. Function expressions, including named
  function expressions, are outside the standard grammar; this keeps callback
  bindings and their lexical scope explicit.
- Semantic input, plain `agent()` text, and items/item aliases are opaque.
  Standard source may forward each whole value into an agent prompt, progress
  log, exact text publication, return value, or unchanged saved/inline item
  scheduling. It may not inspect properties, measure or compare the value,
  branch on it, transform/render it elsewhere, or rename a mapped item.
  Runtime-owned `agent({ choice })` identities, list identity/length, saved-call
  status, callback indexes, and declared loop counters may drive control flow.
  Opaque values may not appear anywhere inside a computed subscript index.
- Arrays, object values, spreads, and nested composites preserve contained
  semantic/runtime provenance. Wrapping a value never makes it author-known;
  unchanged whole values may still reach the documented scheduling,
  publication, prompt, log, and return sinks.
- Every value-bearing callback parameter is classified. A `pipeline()` stage
  receives one opaque value and an optional runtime-owned index; every `.map()`
  parameter, including its whole-array parameter, retains the collection's
  provenance. An unrecognized callback parameter is rejected rather than
  treated as author-known data. Mapping an opaque list remains opaque and cannot
  make its items author-known. Durable key arrays derived from caller items may
  flow only unchanged into the matching `invokeWorkflow()` `key`/`keys` fields.
- No helper function declaration, function-valued variable, object method,
  class, object/variable function wrapper, hidden edge callback, computed object
  key, `schema`/`validate` object key, regex, or `try/catch` is allowed. Inline
  callbacks containing agent edges remain visible only under `parallel`,
  `pipeline`, or `workflow` calls.
- Assignments, augmented assignments, and updates are rejected except when the
  `for` increment mutates one numeric identifier initialized by that same loop.
  That counter may never be a protected DSL, collection, or `Error` binding;
  only `++`/`--` or a numeric `+=`/`-=` step is accepted.
  `new` constructs only the unshadowed global `Error` constructor, and every
  `Error` argument must remain author-known or literal. Opaque/runtime values
  are rejected anywhere inside its message, options, cause, arrays, objects,
  spreads, nesting, or member extraction. Sequence expressions are rejected
  even when every operand is a literal; use one explicit expression or
  statement at a time.
- Run parameters, nested callbacks, lexical declarations, loop bindings, and
  switch blocks may not shadow trusted DSL bindings, recognized collection
  bindings, or `Error`. Bare and parenthesized arrow parameters follow the same
  rule. Assignment targets cannot rebind those trusted names either.
- Every semantic or runtime-owned value-bearing binding name is globally unique
  in one standard source file. This intentionally conservative rule keeps
  provenance independent of JavaScript scope. A nested scalar literal may reuse
  such a spelling; its real lexical block, including a `switch` body, does not
  change the outer value's provenance.

The owner contract separately forbids mandatory acknowledgement protocols whose
answer has no consumer. That is an explicit design/source review rule, not a
prompt-English parser: the structural checker does not guess intent from words
such as `DONE`, `OK`, or `WRITTEN`.

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
export const meta = { name: "<name>", description: "<one line>", profile: "standard" };
export default async function runWorkflow(dsl, input) {
  // use only the dsl members the approved graph needs
}
```

The filename is exactly `<name>.workflow.mjs`. `.pi/workflows/` is the canonical
project target. Source identity and authoring profile are separate gates. The
general `self-contained-static` identity accepts static `node:` imports, and
`legacy`, `integration`, or explicitly reviewed non-standard source may use
that allowance. The `standard` source-shape profile imports nothing. Local,
package, or dynamic imports require literal
`meta.identityCoverage: "entry-only"`, which binds only entry bytes and is also
outside `standard`. The analyzer cannot infer arbitrary eval or `createRequire`
aliases; declare the downgrade honestly.

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
The default per-call and run deadlines are 24-hour emergency fuses, not ordinary
planning deadlines, and each child request keeps a 20-turn host maximum. The
root and all saved children consume one shared physical-call counter.

`meta.profile` makes authoring intent explicit. New generated source uses
`"standard"`; existing compatibility-heavy entries use `"legacy"`, end-to-end
portfolio flows may use `"integration"`, and missing metadata is reported as
`"unclassified"`. Profiles describe source shape; they do not weaken runtime
validation or trust boundaries. Use ordinary natural-language success evidence
from the child—never require a magic acknowledgement literal such as a fixed
one-word token.

## Trust boundary

Workflow JavaScript is reviewed trusted local code executed in Pi’s main Node.js
process with filesystem, subprocess, and network authority. A worktree isolates
changes for review; it is not a security sandbox. Pi exec approval records
consent; it does not remove capabilities. Run only files you have read.
