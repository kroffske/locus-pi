---
name: locus-pi-workflows
description: Find, run, and author locus-pi workflows — the deterministic multi-stage pipelines this package ships. Use when asked what workflows are available, to run one (review, plan, live-smoke, …), to read a finished run's evidence, to copy a shipped example, or to write a new `<name>.workflow.mjs`. Read this before searching the repository for what a "workflow" is.
---

# locus-pi workflows

A workflow here is **one ESM module** named `<name>.workflow.mjs` that runs a
staged pipeline of child agent calls under the `workflows` extension. The script
is ordinary deterministic JavaScript; the models are called from inside it,
through a handle the runtime passes in. That is the point: the structure carries
the run, so a correctly decomposed workflow still finishes on a weak model.

This is not a general term. Do not go looking for CI "workflows" or another
host's DSL — a script written for another agent framework does not run here,
even renamed.

## 1. See what is available

```
/workflows list          # every workflow that resolves right now, plus recent runs
/workflows list <query>  # filter by name or description
/workflows info <name>   # one workflow's declared stages and origin path
```

Each row carries its source: `[P]` project, `[U]` user, `[PKG]` shipped with
this package, `[R]` immutable run history.

## 2. What ships, and where each file is

The `[PKG]` rows need no setup — they resolve out of the installed package
itself, from npm or from a source checkout. All six live under
`extensions/workflows/examples/`, which **is** the Package registry: every
`<name>.workflow.mjs` there is a Package workflow, discovered by existence, with
no second allowlist to keep in sync.

| Name                 | Use it for                                                            | Entry file                                   |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `live-smoke`         | Prove child sessions actually spawn. Two read-only calls, no schemas. | `live-smoke.workflow.mjs`                    |
| `requirements-grill` | Interrogate a fuzzy requirement before anyone plans it.               | `requirements-grill.workflow.mjs`            |
| `review`             | Evidence-backed review of a real target; publishes `review.md`.       | `review/review.workflow.mjs`                 |
| `review-fix`         | Apply the findings a human kept from an immutable `review.md`.        | `review-fix/review-fix.workflow.mjs`         |
| `plan`               | Turn a task into an accepted `plan.md` through a draft/critique loop. | `plan/plan.workflow.mjs`                     |
| `plan-implement`     | Turn that accepted plan into changes, one writer per step.            | `plan-implement/plan-implement.workflow.mjs` |

`plan` → `plan-implement` and `review` → `review-fix` are pairs. The second run
consumes the first run's terminal artifact by digest, not by filename, so a
same-named draft from an earlier round of the same run is refused.

One more worked pipeline ships as reference only — **not** registered, not
launchable by bare name: `extensions/workflows/references/excalidraw-pipeline/`.
Read it for fan-out over many sections with per-section repair and an explicit
per-stage model pin; run it by path if you want to watch it move.

## 3. Run one

```
/workflow-run <name|path> [input]              # canonical
/workflows run <name|path> [input]             # same thing, older spelling
/workflow-run <name> --resume <runId> [input]  # replay recorded answers
```

The model-callable form is the `workflow` tool: `{ name | scriptPath, input,
continuation? }`. Both surfaces accept only **optional bounded text** as input —
at most 16,000 characters. Inline JavaScript is never accepted; a workflow is
always a reviewed file. Cross-run artifacts arrive only through the tool's
closed `continuation` control, never encoded inside `input`.

Start `live-smoke` first on an unfamiliar machine. If it fails, nothing else in
this package will work either, and its failure names the reason.

## 4. Read what a run produced

```
/workflows status               # recent runs
/workflows status <runId>       # one run's stage progress
/workflows result [runId|last]  # the whole terminal text of a finished run
/workflows                      # reopen the oldest pending operator question
/workflow-stop [runId|last]     # explicit cancellation
```

On disk, under the project:

- `.locus/runtime/workflows/<runId>/result.json` — the run envelope.
- `.locus/runtime/workflows/<runId>/artifacts/index.json` — the canonical
  artifact inventory. Every `agent()` attempt persists its exact answer there,
  plus the child transcript for a fresh session.

Top-level `disposition` is the lifecycle truth: `completed`,
`awaiting_operator`, `cancelled`, or `failed`. A run sitting at
`awaiting_operator` is waiting for a human answer, not broken — answer it with
`/workflows` or `/workflow-continue <runId>`.

Inside the script's own returned value, `ok: false` fails the outer run even
with no technical error, and `partial: true` is never a success. A run never
reports success without a real non-empty child answer: fake green is a bug, not
a degraded pass.

## 5. Where a name resolves from

First match wins, walking up from the working directory to the project root:

1. `.pi/workflows/<name>.workflow.mjs` — the canonical project save target.
2. `.claude/workflows/`, then `.agents/workflows/` — same pi-native filename,
   for repositories that already keep agent assets there.
3. `~/.pi/workflows/<name>.workflow.mjs` — personal, this machine only.
4. the package's own `extensions/workflows/examples/` — the Package registry,
   which is why the six above resolve after a plain install.

Only the exact `<name>.workflow.mjs` filename resolves, in every one of these
directories. A `<name>.js` is invisible to the resolver. Project targets are
checked lexically and by canonical real path, so a symlink may only point at a
file that stays inside the project root.

## 6. The handle a workflow is given

The default export receives `(dsl, input)`. Everything a stage needs is on
`dsl`, and that is the whole authoring surface:

| Member                         | What it does                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`         | Run one child agent; resolves to its exact non-empty final text.                    |
| `agent(prompt, { schema, … })` | Same, under a declared answer shape; resolves to the **validated value**, not text. |
| `promptFile(path, vars?)`      | Render a neighboring `.prompt.md`; snapshotted and hashed once per run.             |
| `phase(name)` / `log(msg)`     | Move the reader-visible stage; append a journal line.                               |
| `parallel(thunks)`             | Independent branches behind one fail-closed barrier, input order preserved.         |
| `pipeline(items, ...stages)`   | Ordered stages per item; a failed item stops before its later stages.               |
| `publishArtifact(name, text)`  | Persist deterministic workflow-authored text; returns a digest-bound reference.     |
| `continuationArtifacts()`      | Host-verified prior-run artifacts, bound before any workflow code ran.              |
| `consumeTextArtifact(ref)`     | Verify and copy one complete prior-run text reference into this run.                |
| `captureSourceState(label)`    | Persist a host-owned Git fingerprint around a write-capable stage.                  |
| `awaitOperator({ reason, … })` | Declare that an otherwise successful run is waiting for bounded operator input.     |
| `workspace(label, ref)`        | Allocate one retained linked worktree at an exact Git ref.                          |
| `projectRoot()`                | Absolute project root captured by the runner.                                       |
| `now()` / `random()`           | Replay-safe clock and randomness.                                                   |
| `workflow(subFn, input?)`      | Run a nested workflow function on the same handle.                                  |

Useful `agent()` options: `agent` (catalog name), `readOnly: true`, `tools`,
`maxToolCalls`, `model`, `timeoutMs`, `label`, `phase`, `artifact` (gives the
answer a stable name), `sandbox`, and — on the shaped overload — `schema` plus
`validate`.

## 7. Author a new one

Save it as `.pi/workflows/<name>.workflow.mjs`. Minimum shape:

```js
export const meta = {
  name: "<name>",
  description: "<one line>",
  // Optional, read statically before the run, never enforced:
  // phases: [{ title: "<phase() name>", detail: "<what this stage owns>" }],
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, publishArtifact } = dsl;

  phase("Read");
  const notes = await agent("…one stage task…", { readOnly: true, label: "read" });

  phase("Write");
  const report = await agent(`Turn these notes into a report.\n\n${notes}`, {
    artifact: "report.md",
  });
  publishArtifact("report.md", report);

  return { ok: true, report };
}
```

A shaped stage, for when the script must branch on the answer instead of
forwarding it:

```js
const VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "defects"],
  properties: {
    decision: { type: "string", enum: ["accept", "revise"] },
    defects: { type: "array", maxItems: 12, items: { type: "string", maxLength: 600 } },
  },
};

const verdict = await agent(prompt, {
  schema: VERDICT,
  // Cross-field rules a schema cannot state. Pure, synchronous, returns the
  // violations it found; a non-empty return re-asks the child in its own
  // repair block instead of ending the run.
  validate: (v) => (v.decision === "accept" && v.defects.length > 0 ? ["accept must carry no defects"] : []),
});
```

**Put each check at the cheapest layer that can hold it.** Lengths, counts, id
patterns, enums, uniqueness and blankness belong in `schema`. Cross-field
agreement, referential integrity, and budgets summed across items belong in
`validate`. Only two things stay a fatal `throw`: a child's self-reported status
or its verdict on its own work, and evidence this child did not produce
(host-owned provenance, prior-run text).

**Write stage prompts inline** in the script by default. A neighboring
`resources/<stage>.prompt.md` rendered through `promptFile()` is the escape
hatch for a role charter long enough to bury the routing — roughly 80 lines and
up — or a prompt shared by more than one workflow.

### Four rules that decide whether the file runs at all

- **Use `dsl` only.** The runtime does not enforce this — see the trust note —
  but it is what keeps a script portable and replayable.
- **Take time and randomness from `dsl.now()` / `dsl.random()`**, never
  `Date.now()`, `new Date()`, or `Math.random()`. A direct clock call is not
  rejected; it silently marks the run unrecordable, so `--resume` can no longer
  replay it.
- **Keep the default identity.** Static `node:` imports only. Local, package, or
  dynamic imports require the literal `meta.identityCoverage: "entry-only"`
  downgrade, which binds the entry bytes and nothing else. Never call that entry
  hash full script identity.
- **Fail closed.** An uncaught group failure from `parallel()`/`pipeline()`
  fails the outer run, and that is usually the right outcome. Catch
  `error.code === "WORKFLOW_GROUP_FAILURE"` only when the requirements
  explicitly accept partial work, then return `partial: true` evidence.

## 8. Copy from the shipped examples

Read the entry file rather than inventing a shape. Each one is the smallest
place a given technique is visible:

| Read this                                    | To see                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke.workflow.mjs` (51 lines)         | The smallest complete workflow: two sequential read-only calls, one input check, no schemas.                                                             |
| `requirements-grill.workflow.mjs`            | Workflow-owned repository search — a bounded `rg` the script runs itself instead of asking an agent — and fail-closed exits at every stage.              |
| `review/review.workflow.mjs`                 | A staged text pipeline, two shaped gates, a bounded loop, an operator handoff that splits the run, and both prompt-placement rules in one file.          |
| `review-fix/review-fix.workflow.mjs`         | A model-planned dependency graph that deterministic code validates and orders before any writer starts; one writer per finding; host-owned fingerprints. |
| `plan/plan.workflow.mjs`                     | Two loops with different owners: an operator clarification round that can pause the run, and a draft/critique loop whose exit is a shaped verdict.       |
| `plan-implement/plan-implement.workflow.mjs` | The receiving end of a cross-run handoff: host-verified plan bytes, deterministic step parsing, one writer per step, and a deliberate `partial: true`.   |

`extensions/workflows/examples/README.md` tabulates the same set with measured
line counts, prompt placement, and which checks each one declares in a schema
versus a validator — read it when choosing which file to imitate.

## 9. Trust boundary, stated plainly

Workflow JavaScript executes as reviewed trusted local code in Pi's main Node.js
process, with full filesystem, subprocess, and network capability. Worktrees,
identity hashes, and Pi's `exec` approval are evidence and consent records.
This package does **not** sandbox workflow code. Run only files you have read.

## 10. Read next

Relative to this skill's own directory:

- `../../extensions/workflows/AUTHORING.md` — the authoring pointer, with the
  full resolution, result, artifact, and replay contract.
- `../../docs/extensions/active/workflows.md` — the canonical source of truth for
  the DSL, its options, the trust model, and every command surface.
- `../../extensions/workflows/references/patterns.md` — stage patterns worth
  copying.
- `../../extensions/workflows/examples/README.md` — what each shipped example
  demonstrates and how far it travels.

To have one written for you, delegate to the catalog agent: `/agent run
workflow-author`, or the `task` tool with `{ agent: "workflow-author", task:
"<requirement>" }`. It writes to `.pi/workflows/`.
