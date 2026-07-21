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
  const { agent, phase, log, promptFile, parallel, pipeline, workflow } = dsl;
  // Authoring policy: use `dsl` only. Runtime does not enforce this boundary;
  // imported modules have full host Node.js capabilities. Run reviewed files only.
  // `input` is the run's task: the free-text [input] from the run command, or a
  // JSON object of named parameters when the caller used the `workflow` tool.
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
- **Run:** `/workflows run <name|path> [input]` or the
  `workflow { name | scriptPath, input }` tool. The command passes free text; the
  tool also accepts a JSON object of named parameters. A parameterised workflow
  normalises both shapes once at the top and keeps the string branch usable —
  see "Workflow input" in the canonical doc and the pattern catalog. Arbitrary
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

For _which shape to pick_ (single-agent, shaped `agent({ schema })` gate, staged text pipeline,
loop+judge, plan→build→review, adaptive owner-local, pipeline, fan-out+merge,
judge-panel, loop-until-dry), use the inline skeletons in the pattern catalog
[`references/patterns.md`](./references/patterns.md). Multi-step work on one
subject defaults to the staged text pipeline used by the curated `review` and
`review-fix` workflows: sequential `agent()` stages with one cognitive job each,
exact text handoffs the workflow never parses, every `readOnly: true` inspection
stage before any writing stage, and source mutation kept separate from artifact
publication. Take the stage count from the requirement — two stages is a
complete pipeline. For the full primitive table,
schema/trust rules, and edge-cases, read the canonical doc linked above.

For a non-trivial workflow visual map, use `$pi-workflow-diagram`. Every curated
Package workflow must keep `<name>-pipeline.diagram.mjs`, editable
`<name>-pipeline.excalidraw`, and `<name>-pipeline.png` beside its source. The
diagram must distinguish operator input, workflow-owned routing, child agents,
and persisted artifacts; every decision and branch names its real owner. The canonical diagram contract lives in the authoring section of
the workflow documentation linked above.
