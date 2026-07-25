# Authoring a pi-workflow — pointer

> **Canonical reference:** [`docs/extensions/active/workflows.md`](../../docs/extensions/active/workflows.md)
> is the single source of truth for the DSL, options, schema, trust model, name
> resolution, run commands, result/journal layout, and the "what is NOT supported"
> contract. This file is a co-located pointer so the contract is reachable from the
> extension directory; do not fork content here — edit the canonical doc.

A workflow is one ESM module `<name>.workflow.mjs` with two exports:

Workflow `.mjs` scripts execute as reviewed trusted local JavaScript with full
Node.js host capabilities. They are not sandboxed. A worktree
isolates file changes for diff UX, and Pi `exec` approval records consent for the
programmatic tool; neither is a security boundary. `dsl` is the intended authoring
handle. Default `self-contained-static` identity accepts only static `node:` imports
and executes the retained snapshot. Modular/source-anchored behavior requires the
literal evidence downgrade `meta.identityCoverage: "entry-only"`; that allows
ordinary imports but does not bind dependency bytes.

The analyzer recognizes declared/direct module syntax; it cannot infer
`createRequire` aliases, eval-generated imports or arbitrary dynamic code. Such
behavior still requires an author-declared `entry-only` downgrade. Snapshot/hash
checks are point-in-time trusted-host evidence, not an atomic filesystem guarantee.

```js
export const meta = {
  name: "<name>",
  description: "<one line>",
  // Optional. Declares the pipeline before the run; read statically, never enforced.
  // phases: [{ title: "<phase() name>", detail: "<what this stage owns>" }],
};

export default async function runWorkflow(dsl, input) {
  const {
    agent,
    publishArtifact,
    consumeTextArtifact,
    continuationArtifacts,
    captureSourceState,
    awaitOperator,
    phase,
    log,
    promptFile,
    parallel,
    pipeline,
    workflow,
  } = dsl;
  // Authoring policy: use `dsl` only. Runtime does not enforce this boundary;
  // imported modules have full host Node.js capabilities. Run reviewed files only.
  // `input` is absent or the exact bounded semantic text supplied by the caller.
  // Cross-run refs arrive separately through continuationArtifacts().
  // The returned value is written to result.json as `result`.
}
```

Keep the default template self-contained. If reviewed requirements genuinely need
local/package/dynamic imports, `require` or `import.meta`, add
`identityCoverage: "entry-only"` to the literal exported `meta` object. Never call
that entry hash full script identity.

Before running a newly authored file, use the repository's
`assessWorkflowSourceIdentity()` helper to validate the policy against its exact
bytes; direct `node import()` alone does not apply the runner's coverage gate.

- **Author from requirements:** delegate to the `workflow-author` catalog agent
  (`.agents/agents/workflow-author.md`) — `/agent run workflow-author` or
  `task { agent: "workflow-author", task: "<requirement>" }`.
  The helper writes saved workflows; the package surface remains the `workflows`
  extension.
- **Save** so it resolves by name. Resolution order (first match wins, walking up
  from the working directory to the project root):
  1. `.pi/workflows/<name>.workflow.mjs` — the **canonical pi-native save target**
     (where `workflow-author` writes).
  2. `.claude/workflows/<name>.workflow.mjs`, then `.agents/workflows/<name>.workflow.mjs`
     — **additional project directories** for repositories that already keep agent
     assets there. Same pi-native format and same exact filename: a `<name>.js`
     in these directories is not found, and a script written against another
     host's workflow DSL will not run here even if renamed. Port it to the DSL
     contract instead.
  3. personal `~/.pi/workflows/<name>.workflow.mjs`.
  4. the curated Package registry in `CURATED_PACKAGE_WORKFLOW_NAMES`. Files under
     `extensions/workflows/examples/` are not registered merely because they exist.
     This repository's `locus-plan` and `test-code` workflows live in ignored
     `.pi/workflows/` only. They are project-local planning/testing dogfood, not
     tracked examples, curated Package workflows, or npm package files.
     Their final planning verifier and test attribution roles use
     host-enforced `readOnly: true` plus `repository_check`, never unrestricted
     shell, and their intent, plans, units, predecessor handoffs, results, and
     final verification inputs have explicit bounds.
- **Run:** `/workflow-run <name|path> [input]` (compatibility:
  `/workflows run <name|path> [input]`) or the
  `workflow { name | scriptPath, input, continuation? }` tool. Both surfaces pass
  only optional bounded semantic text. The tool can separately attach 1–8
  complete prior-run artifact refs through its closed `continuation` control;
  direct slash continuation is not supported. Arbitrary
  inline JS is **not** supported — trusted-file only.
  Project targets are checked lexically and by canonical `realpath`; symlinks may
  point only to files that remain inside the project root when resolved. Do not replace
  a workflow target concurrently during launch: validation and Node import are not atomic.
- **Keep the workflow resumable:** take wall-clock time and randomness from
  `dsl.now()` / `dsl.random()`, never from `Date.now()` / `new Date()` /
  `Math.random()`. Those values are recorded, so
  `/workflows run <name> --resume <runId>` can replay the recorded `agent()`
  answers instead of paying for the earlier stages again. A direct clock or
  randomness call is not rejected — the AST scan simply marks the script
  unproven and refuses to record or replay it. Replay rules, refusal reasons, and
  the replayed-run marking are in the canonical doc.
- **Read the result:** `.locus/runtime/workflows/<runId>/result.json`. Top-level
  `disposition` is the operator lifecycle truth: `completed`,
  `awaiting_operator`, `cancelled`, or `failed`. Use
  `awaitOperator({ reason, operatorHandoff? })` immediately before a successful
  handoff return. The optional handoff declares bounded select/text questions
  plus exact current-run continuation artifact refs; the runner supplies its
  version, origin, stable id, and verified target/script identity. It records
  outside the returned value, so existing payload/continuation shapes stay
  unchanged. A reason-only declaration remains valid but is not directly
  actionable. The runner honors the declaration only when the run otherwise
  succeeds; an abort or failure takes precedence. The last declaration wins.
  The host can reopen the oldest actionable question through `/workflows` or
  `/workflow-continue <runId>`, verifies artifacts and identity again, atomically
  claims one continuation, and never rewrites source `result.json`. Escape
  snoozes; `/workflow-stop` is the explicit cancellation path. Top-level
  boolean `result.ok` is reserved as the script's run outcome: `false` makes the
  outer run fail even without a technical `error`; missing, nested, or
  non-boolean `ok` keeps legacy execution-success semantics. A top-level
  `partial:true` also makes the outer run fail; a deliberate partial may
  omit an `error` string, but it is never a successful completion. A semantic failure
  may carry `summary` and `unresolvedRows`, which the command, tool, transcript,
  and progress surfaces project exactly. Independently, a non-JSON-safe return
  value or failure to persist this mandatory envelope is an infrastructure
  failure and makes the outer run `ok:false`; there is no successful
  result-unavailable or write-warning-only state.
- **Keep evidence under the run owner:**
  `.locus/runtime/workflows/<runId>/artifacts/index.json` is the canonical
  artifact inventory. Every `agent()` attempt automatically persists its exact
  answer and, for a fresh child session, its Pi transcript and result envelope.
  Use `agent(prompt, { artifact: "report.md" })` to give that answer a stable
  name. Use `publishArtifact(name, text)` for deterministic workflow-authored
  text. Agent-first cross-run calls attach complete digest-bound
  `{ runId, artifactId, name, sha256 }` refs through the workflow tool's closed
  `continuation` control. The host verifies and copies every ref before the
  workflow module or any child starts; `continuationArtifacts()` exposes readonly
  `{ sourceRef, consumedArtifact }` pairs. A path, run id, partial reference, or
  ref encoded inside `input` is not enough. Trusted scripts may still call
  `consumeTextArtifact(ref)` when the ref is already fixed by reviewed code and
  appears in the successful source run's terminal `artifactRefs` projection.
  Being present only in the full artifact index is not a continuation handoff.
  The consumer verifies projection membership, index identity, digest, media
  type, size, confinement, and bytes before copying the text into its own run
  with source lineage and verified source workflow identity. The consumed value
  also exposes the validated source terminal JSON result and projected refs;
  use them when the consumer must prove that refs were named by a structured
  prepare result or that bytes were the run's final string output rather than
  merely an indexed same-name artifact. The runtime validates the complete
  physical directory chain from the resolved project root through the run root;
  a symlinked `.locus`, `runtime`, or deeper ancestor fails closed. Artifact names are
  one safe component (1-128 ASCII letters, digits, `.`, `_`, or `-`, beginning
  with a letter or digit); text is limited to 2 MiB. Duplicate names are allowed,
  because `artifactId` is the identity; duplicate ids or destinations fail closed.
  The completed run envelope and model-callable workflow tool project the newest
  20 answer/published refs and an explicit omitted count, so a later call can
  carry a real ref without guessing the index. The full index remains canonical.
- **Fingerprint mutable remediation:** `captureSourceState(label)` persists a
  host-owned Git fingerprint under the current run. Use it around write-capable
  stages and read-only checks to distinguish expected writer changes from drift
  outside the declared window. Every initialized gitlink is enumerated
  independently of its parent modification state and contributes the checked-out
  submodule HEAD, index, status, and changed/untracked bytes. It records
  evidence; it does not lock the checkout.
- **Treat groups as fail-closed full barriers:** `parallel()` / `pipeline()` wait
  for scheduled siblings, then reject `WorkflowGroupFailureError` when an
  ordinary branch or stage throws or directly returns `ok:false` /
  `status:failed|blocked|cancelled`. An uncaught group failure makes the outer
  run `ok:false`. `WorkflowInvocationCapError` remains a separate hard run-level
  failure.
  A fulfilled `null` remains a successful value; discriminated `error.slots`
  distinguishes it from a failed position. Default to leaving the typed error
  uncaught. If requirements explicitly accept partial work, catch only
  `error.code === "WORKFLOW_GROUP_FAILURE"`, rethrow every other error, inspect
  `slots` / `partialResults` in memory, and return JSON-safe `partial:true`
  evidence. The runner still projects that deliberate partial as non-success.

The catalog also owns _what happens inside one stage_: see its "Writing one stage
task" section for the four decisions a stage makes and for the bounded set of
checks trusted code may perform. Handoffs pass forward as exact text — the script
bounds emptiness and size, confines operator-supplied paths, and verifies
host-owned lineage, and never grades model prose. Branch on a declared shape with
`agent({ schema })`, whose runtime retry re-asks the child with the previous
validator errors before failing closed.

For _which shape to pick_ (single-agent, shaped `agent({ schema })` gate, staged text pipeline,
loop+judge, plan→build→review, adaptive owner-local, pipeline, fan-out+merge,
judge-panel, loop-until-dry), use the inline skeletons in the pattern catalog
[`references/patterns.md`](./references/patterns.md). Multi-step work on one
subject defaults to the staged text pipeline used by the curated `review` and
`review-fix` workflows: sequential `agent()` stages with one cognitive job each,
exact text handoffs the workflow never parses, every `readOnly: true` inspection
stage before any writing stage, and runtime-owned artifact persistence rather
than a publisher child. Take the stage count from the requirement — two stages is a
complete pipeline. For the full primitive table,
schema/trust rules, and edge-cases, read the canonical doc linked above.

For a non-trivial workflow visual map, use `$pi-workflow-diagram`. Every curated
Package workflow must keep `<name>-pipeline.diagram.mjs`, editable
`<name>-pipeline.excalidraw`, and `<name>-pipeline.png` beside its source. The
diagram must distinguish operator input, workflow-owned routing, child agents,
and persisted artifacts; every decision and branch names its real owner. The canonical diagram contract lives in the authoring section of
the workflow documentation linked above.
