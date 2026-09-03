# Authoring a readable pi-workflow

The bundled entry point is
[`skills/locus-pi-workflow-create/SKILL.md`](../../skills/locus-pi-workflow-create/SKILL.md).
The complete runtime, trust, replay, and artifact reference is
[`REFERENCE.md`](REFERENCE.md).

## Contract: Design, review, Build

A plain request to create, design, write, or author a workflow runs one ordered
authoring sequence: create `.locus-pi/workflows/<name>/`, write
`<name>/<name>.design.md`, review and revise that design against the request and
standard source profile, then write exactly the direct `.workflow.mjs` entries
declared by the design. A `runnable root` design includes
`<name>/<name>.workflow.mjs`; a `group-only` design omits it and writes only
its direct children. Build checks every source identity and module load and does
not run the workflow.

The folder is the workflow namespace and public name. Its same-named file is the
standard operator entry point. A direct `<child>.workflow.mjs` is a runnable
child with logical ref `<name>/<child>`; do not repeat the root prefix in the
child filename. New authoring always uses this layout. Existing flat Project or
User files remain runtime-compatible standalone workflows.

A folder may intentionally be group-only: it can contain direct child workflow
files without `<name>.workflow.mjs`. The children remain runnable by their
qualified refs, while the folder name is a non-runnable catalog header. Adding
the same-named root later makes that namespace runnable without renaming its
children. Group-only folders must not be mixed with lower-precedence User or
Package children; the first source that owns the namespace owns all of it.

The design always precedes source. The author stops after design only when the
user explicitly asks for `design only`, `pause after design`, `do not build`, or
equivalent wording. Build-only compatibility requests remain available:

```text
Build design: .locus-pi/workflows/<name>/<name>.design.md
Build approved design: .locus-pi/workflows/<name>/<name>.design.md
```

Both Build-only forms use the current design bytes at the exact path; there is no
separate token or stored digest. A material algorithm mismatch returns to design
revision and review before source is created or replaced. Routine corrections do
not introduce another human stop; ask only when the correction changes the
requested result.

Use the packaged `locus-pi-workflow-create` skill. A raw request is Author:
Design first, review, then Build. The exact design template and standard source
profile live in that skill and this extension documentation.

The Package `task/draft` workflow can turn a raw request into an editable
`draft.md` that already names the graph pattern, agents, handoffs, review bounds,
concurrency, failure exits, and primary output. Copy or edit that complete text,
then pass it as semantic input to `task/plan`. That second workflow designs,
reviews, builds, checks, and publishes one concrete `workflow.mjs`; it does not
run the generated source.

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

It also contains one `## Entries` table with the exact source set. Each row
declares a logical ref, `root` or `child` role, one responsibility, and its
invoker. The root ref is `<name>`. Child refs are `<name>/<child>`. Build must
neither omit a declared entry nor add an undeclared one.

Agent count is not a complexity penalty. Hidden machinery is. Count raw schema,
validator, parser, custom retry/recovery, execution wrapper, renderer, hidden
state, loop, judge, and concurrency barrier.

Pattern cards are progressive-disclosure references under
[`skills/locus-pi-workflow-create/references/`](../../skills/locus-pi-workflow-create/references/INDEX.md).
They describe algorithms and truthful small snippets, not full scripts to copy.

## Standard primitive profile

The packaged `locus-pi-workflow-create` skill emits an orchestration-only subset
of this profile. New generated source contains author-known prompts, direct
`agent()` edges, visible DSL control flow, and in-memory text publication. It
does not call `consumeTextArtifact`, `continuationArtifacts`, `outputDir`,
`projectRoot`, `promptFile`, `publishPrimaryFile`, `workspace`, `now`, or
`random`. Those methods remain documented below only because the standard
checker must validate existing reviewed workflows. The skill calls
`workflow_check_source` with `mode: "orchestration-only"`, which machine-checks
the narrower Build contract.

`agent()` is the only model-calling primitive. Narrative output is exact text.
When JavaScript must route, use the runtime-owned exact choice:

```js
const route = await agent("Choose the next step.", {
  choice: ["accept", "revise", "blocked"],
  choiceFallback: "blocked",
});
```

The runtime desugars `choice` to its existing string-enum shape path. It owns
format instructions, parsing, validation, corrective re-ask, journal evidence,
replay, and budgets. A child that answers with the bare member text or echoes the
schema as `{"type":"string","value":"…"}` is read as that member and the journal
records the reading; anything else is re-asked once. By default exhaustion fails
closed. A design may declare
`choiceFallback` as one of the listed choices when a deterministic degraded route
is safer; the runtime uses it only after both invalid answers and records the
fallback in the journal. Workflow code does none of that recovery itself.

When discovery determines the work units at runtime, use bounded text handoffs:

```js
const MAX_DAGS_IN_SCOPE = 12;
const units = await agent("Return one complete handoff per discovered unit.", {
  handoffs: { minItems: 1, maxItems: MAX_DAGS_IN_SCOPE, maxItemChars: 4000 },
});
```

Runtime desugars `handoffs` to its bounded unique non-blank string-array path and
owns the same format instructions, repair, replay, journal, budget, and
fail-closed behavior. Workflow code passes each returned string unchanged into
visible `parallel()` or `pipeline()` workers. The approved Design derives and
names a small `maxItems` in the runtime range `1..100`; the bound protects one
structured response and is not a default business limit. Runtime allows one
repair, then fails closed.

The remaining standard orchestration primitives are:

| Primitive                            | Responsibility                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `parallel(thunks)`                   | One fail-closed barrier over independent author-known calls.               |
| `pipeline(items, ...stages)`         | Fixed ordered stages for each author-known item.                           |
| `phase(name)` / `log(text)`          | Reader-visible run progress.                                               |
| `publishArtifact(name, text)`        | Supporting exact text artifact.                                            |
| `publishPrimaryArtifact(name, text)` | One terminal semantic document.                                            |
| `awaitOperator(declaration)`         | Explicit human pause with runtime-owned continuation.                      |
| `items()`                            | Immutable exact caller-supplied text units.                                |
| `outputDir()`                        | Project-relative workflow workspace selected by the host.                  |
| `invokeWorkflow(declaration)`        | One real saved or exact-Package child run with durable item checkpointing. |
| `publishPrimaryFile(path)`           | Validate/reference one non-empty workflow workspace file.                  |
| `promptFile(path, variables)`        | Long/shared role charter; never routing.                                   |
| `workspace(label, ref)`              | Runtime-owned retained worktree for approved write flows.                  |

`runWorkspaceDir()` is removed. Existing source that calls it fails with
`WorkflowRunWorkspaceRemovedError`; migrate to `outputDir()` and the single
project-local workflow workspace. The runtime does not create a run-local
`workspace/` directory.

Trusted raw `schema` and `validate` remain an advanced compatibility surface for
existing workflows. Standard generated source uses only exact text, `choice`,
and `handoffs` answers.

Standard generated source omits `maxToolCalls` and `timeoutMs`. The package
already supplies emergency per-attempt defaults. Emit one of those fields only
when the operator explicitly requests a narrower or raised per-attempt fuse and
the approved Design records why. Do not mechanically sweep legacy workflows.

Portable `modelRole` normally degrades to the parent session model with recorded
evidence when no layer assigns it. A stage whose accepted evidence depends on
that exact tier may declare `requireModelRole: true` beside its explicit
`modelRole`. Record the fail-closed requirement in Design. Do not use the flag
with concrete `model`, as a prestige selector, or without naming why fallback
would invalidate a fresh run. Replay starts no child and follows the recorded
evidence contract.

Standard generated source also omits `ask: true`. Live operator questions
(`agent({ ask: true })`, REFERENCE "Live operator questions") are an
interactive capability for operator-attended workflows: the child asks through
`workflow_ask` and continues with the answer in the same session. Declare it
only when the approved Design names the stage that may ask and why an
assumption is not enough — decomposing unknowns into explicit assumptions
remains the default. An `ask: true` stage makes the workflow unusable in
`print`/`json` and unattended runs (the call fails closed with
`ask-unavailable`), so a pipeline meant for automation must not declare it.

The same applies to `dsl.awaitOperator(...)`: an unattended caller may launch
any workflow with the run-level no-operator mode (`/workflows run <name>
--no-operator`, or the `workflow` tool's `noOperator: true`), and under that
mode every request for operator input — `awaitOperator` or an `ask: true`
stage — fails closed with a named reason instead of pausing the run. A
headless launch (`print`/`json`) turns that mode on by default, so any workflow
run from a pipeline is in it unless the caller passes `--operator`. Author for
that reality: a workflow meant for automation asks nothing and turns unknowns
into explicit assumptions inside its result.

## Target source shape

Keep stable stage option groups together near the top. Keep prompts, calls,
branches, and handoffs visible at their execution edges. Stage prompts own their
roles; package agent names are never required.

```js
export const meta = {
  name: "review-task",
  description: "Review one task and publish the complete result.",
  profile: "standard",
};

const AGENTS = {
  reviewer: {},
  composer: {},
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
work by default. If repository evidence is needed, the child reads it because
its prompt asks for that work. Workflow JavaScript does not obtain paths or load
file contents on the child's behalf.

The runtime still prepends one exact absolute workflow workspace to every child
prompt. Fresh runs default to a unique
`.locus-pi/workspaces/<generated-run-name>/` workspace under the project root. A
qualified child keeps both name components in its generated leaf. Source may call
`outputDir()` when it needs the project-relative identity, but authors should
only need to name the assigned relative file and the idempotent replacement
rule. Package task drafting and planning use the same workspace contract;
saved children and later manual stages share the selected named path. Use
`projectRoot()` for source context. Do not add permission/tool fields,
another default writable root, a path parser, or an information-gathering script.

That path-oriented shape is compatibility guidance for existing hand-authored
workflows. The packaged authoring skill does not generate it. New source puts
source-inspection instructions in an `agent()` prompt and leaves filesystem work
inside that child session.

Semantic workflow input is not a hidden machine protocol. Standard source does
not split, regex-match, or parse input into branch units. Lists come from one of
three explicit sources: an author-known array, exact caller transport through
`dsl.items()`, or runtime-owned `agent({ handoffs })`. All three feed the same
visible `pipeline(items, ...)` body. Caller items preserve order and exact bytes,
including empty strings and duplicates, with no Locus items count or character
policy; a workflow
checks only domain rules it truly needs. Model handoffs retain their separate
declared bounds, corrective re-ask, blank rejection, and duplicate rejection.

Compatibility-only durable item workflows may start from a caller-frozen approved list. The root then
invokes one reviewed sibling child per key and passes that same full list on
every call, allowing the host to reject duplicate or unsafe keys before the
first child starts:

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
      child: "worker",
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
Use `child` for an entry in the running root's folder. The runtime binds that
child to the root's exact selected source, so lower-source children cannot leak
into the tree. Use `name` only for an explicit cross-tree call; it accepts a root
or qualified `<root>/<child>` and follows normal Project → User → Package
precedence. `scriptPath` remains exact project-source selection and
`packageName` remains legacy exact-Package compatibility.
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

The workflow workspace is distinct from run evidence. Fresh runs default to a
unique `.locus-pi/workspaces/<generated-run-name>/` directory; callers may select
another safe project-relative `outputDir`. `--run-name <name>` selects
`.locus-pi/workspaces/<name>` for any workflow. An existing legacy-only
`.locus-pi/plans/<name>` stays bound in place. Every child receives the
resolved absolute path once. Writers
replace their assigned file atomically or otherwise idempotently—never append blindly.
`publishPrimaryFile(relativePath)` validates one regular, non-symlink, non-empty
file under that root and returns its path, byte count, and SHA-256 digest without
copying or interpreting the content. Failed runs leave workspace files intact for
inspection and retry.

Runtime связывает workspace с группой в `.locus-pi/runs/<storageRootRunId>/README.md`.
Saved children сохраняют отдельные IDs в `children/<runId>/`, root resume — в
`attempts/<runId>/`. Не вычисляйте путь evidence из одного runId: используйте
возвращённый `runDir` или команды status/result. Автоматические файлы группы и
workspace `.workflow-runs.md` принадлежат runtime; не поручайте agents их переписывать.
Resume сохраняет workspace и физическую группу, но создаёт новый execution root;
`lineage.rootRunId` не означает первый запуск группы. Checkpoint/replay правила от
группировки не меняются, старые flat runs и workspace не мигрируют.

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
engine. Inside Pi, call the read-only `workflow_check_source` tool with the
project-relative path of the exact file Build produced:

```json
{
  "path": ".locus-pi/workflows/<name>/<name>.workflow.mjs",
  "mode": "orchestration-only"
}
```

Run the same check for every declared direct child file. Build succeeds only
when the design `Entries` set, files, `meta.name` values, module imports, and
source checks all agree.

The tool is owned by the installed `workflows` extension and resolves the path
inside the current project. It behaves the same for a source checkout and an
installed package. Omitting `mode` keeps compatibility validation for existing
reviewed workflows; the workflow-create skill never omits it. Repository
maintainers use `npm run check:workflow-source`
with no path to check every `standard` entry
already present in the Package registry. Neither command discovers
or adds registry entries. The repository-wide `npm run check` gate runs that
Package check. Source-shape validation does not replace source-identity
assessment or importing the module.

Diagnostics are compiler-shaped. Human-readable output uses
`path:line:column [CODE] message`; the tool result also returns the full
`diagnostics` array with stable `code`, `severity`, one-based source spans, and
optional related spans. An `error` fails the tool. A `warning` keeps the check
successful while making declaration drift visible. Existing automation that
calls `standardWorkflowSourceShapeErrors()` keeps the legacy sorted `string[]`
error projection; warnings are intentionally absent from that compatibility
view.

Build remains failed until the exact source passes this checker, module import,
identity checks, and design/source comparison. An unavailable tool or failed
checker result cannot be reported as a successful Build.

These are all rules enforced for `meta.profile: "standard"`:

- Source must parse as JavaScript. The module has exactly one literal
  `export const meta` whose profile is
  `"standard"`, plus exactly one visible default function or arrow export. A
  named entry is `run` or `runWorkflow`. Other top-level declarations are
  `const` values made only from literal arrays, objects, scalars, and static
  strings; comments and a hashbang are harmless, but there are no other
  statements or exports.
- `meta.phases` remains optional. When it is a non-empty literal array, it is
  the complete unique vocabulary of literal `phase("...")` calls in planned
  first-source order. An exact or case-equivalent duplicate declaration, a
  case-only call mismatch, or an undeclared literal phase is an error. An unused
  declaration or order drift is a warning. Repeated calls to the same phase and
  branches not reached in one run are valid; the checker compares source
  vocabulary, not runtime reachability.
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
  references and host paths may flow whole into an agent/log/return. A reference
  returned by `publishArtifact`, `publishPrimaryArtifact`, or
  `publishPrimaryFile` may also appear unchanged as a direct array element only
  at `awaitOperator({ operatorHandoff: { continuationArtifactRefs: [...] } })`.
  A published reference may also flow unchanged to one question's
  `detailArtifactRef` when that exact ref appears in the continuation array; the
  runtime reads and bounds its text for UI instead of letting workflow source
  inspect or interpolate it.
  Another runtime value, property, nesting layer, or derived form remains
  rejected. This source-shape rule checks only the static producer and sink; the
  host runtime verifies that every reference belongs to the terminal source run
  and appears in its terminal artifact projection. Void calls are standalone
  effects and cannot be bound, nested, or returned as values.

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

The filename is exactly `<name>.workflow.mjs`. `.locus-pi/workflows/` is the canonical
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
absent. Human launch uses `/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]`;
both options precede semantic input. Use the conventional `--` end-of-options
delimiter when semantic input begins with `--resume`, `--output-dir`, `--`, or
another option-looking token; every character after that delimiter is passed as
input unchanged. Cross-run data arrives through host-verified continuation
artifacts.
`agent({ artifact })` names the runtime-captured exact answer;
`publishPrimaryArtifact()` declares the one successful terminal document.

`parallel()` and `pipeline()` wait for scheduled siblings and then reject on a
failed branch. Root returns, direct parallel branches, and direct pipeline
stages share one returned-outcome rule: `ok === false`, `partial === true`, or
`status: "failed" | "blocked" | "cancelled"` is semantic failure. The same
JSON object therefore has the same terminal meaning wherever it is returned.
Failure statuses remain domain detail; the durable run disposition is
`failed`. Other JSON-safe shapes keep legacy success semantics.

Invocation cap, timeout, inherited tool access, answer
bounds, transport retry policy, artifact integrity, continuation, operator
approval, and replay are runtime responsibilities. The package-wide
budget allows 1,000 tool calls, a 24-hour timeout, 20 turns, and 500,000 answer
characters per child attempt. One run admits at most 10,000 physical attempts,
starts no new child after its 24-hour gate, and executes at most four attempts
concurrently. Implementer, reviewer, transport-retry, and value-repair attempts
all consume the shared `totalAgents` counter across the root and saved children.
The SDK timeout is a later transport backstop, not authored workflow policy.

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
