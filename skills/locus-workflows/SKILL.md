---
name: locus-workflows
description: Find, run, and author locus-pi workflows — the deterministic multi-stage pipelines this package ships. Use when asked what workflows are available, to run one (review, plan, live-smoke, …), to read a finished run's evidence, or to write a new `<name>.workflow.mjs`. Read this before searching the repository for what a "workflow" is.
---

# locus-pi workflows

A workflow here is **one ESM module** named `<name>.workflow.mjs` that runs a
staged pipeline of child agent calls under the `workflows` extension. The script
is deterministic code; the models are called from inside it. That is the point:
the structure carries the run, so a correctly decomposed workflow still finishes
on a weak model.

This is not a general term. Do not go looking for CI "workflows" or another
host's DSL — a script written for another agent framework does not run here.

## 1. See what is available

```
/workflows list          # every workflow that resolves right now, plus recent runs
/workflows list <query>  # filter by name or description
/workflows info <name>   # one workflow's declared stages and origin path
```

Each row is tagged with its source: `[P]` project, `[U]` user, `[PKG]` shipped
with this package, `[R]` immutable run history.

The `[PKG]` rows need no setup — they resolve out of the installed package
itself. These six ship:

| Name                 | Use it for                                                            |
| -------------------- | --------------------------------------------------------------------- |
| `live-smoke`         | Prove child sessions actually spawn. Two read-only calls, no schemas. |
| `requirements-grill` | Interrogate a fuzzy requirement before anyone plans it.               |
| `review`             | Evidence-backed review of a real diff; produces `review.md`.          |
| `review-fix`         | Apply fixes a human selected from an immutable `review.md`.           |
| `plan`               | Turn a task into an accepted `plan.md` through a draft/critique loop. |
| `plan-implement`     | Turn that accepted plan into changes, one writer per step.            |

`plan` → `plan-implement` and `review` → `review-fix` are pairs: the second run
consumes the first run's terminal artifact by digest, not by filename.

## 2. Run one

```
/workflow-run <name|path> [input]              # canonical
/workflows run <name|path> [input]             # same thing, older spelling
/workflow-run <name> --resume <runId> [input]  # replay recorded answers
```

The model-callable form is the `workflow` tool: `{ name | scriptPath, input,
continuation? }`. Both surfaces accept only **optional bounded text** as input.
Inline JavaScript is never accepted — a workflow is always a reviewed file.

Start `live-smoke` first on an unfamiliar machine. If it fails, nothing else in
this package will work either, and its failure names the reason.

## 3. Read what a run produced

```
/workflows status            # recent runs
/workflows status <runId>    # one run's stage progress
/workflows result last       # the whole terminal text of the last finished run
/workflows                   # reopen the oldest pending operator question
```

On disk, under the project: `.locus/runtime/workflows/<runId>/result.json` is the
run envelope, and `.locus/runtime/workflows/<runId>/artifacts/index.json` is the
canonical artifact inventory.

Top-level `disposition` is the lifecycle truth — `completed`,
`awaiting_operator`, `cancelled`, or `failed`. A run that stops at
`awaiting_operator` is waiting for a human answer, not broken; answer it with
`/workflows` or `/workflow-continue <runId>`. A run never reports success
without a real child answer: fake green is a bug, not a degraded pass.

## 4. Where a name resolves from

First match wins, walking up from the working directory to the project root:

1. `.pi/workflows/<name>.workflow.mjs` — the canonical project save target.
2. `.claude/workflows/`, then `.agents/workflows/` — same pi-native filename,
   for repositories that already keep agent assets there.
3. `~/.pi/workflows/<name>.workflow.mjs` — personal, this machine only.
4. the package's own `extensions/workflows/examples/` directory — the Package
   registry, which is why the six above are there after a plain install.

Only the exact `<name>.workflow.mjs` filename resolves. A `<name>.js` is
invisible to the resolver in every one of these directories.

## 5. Author a new one

Save it as `.pi/workflows/<name>.workflow.mjs`. Minimum shape:

```js
export const meta = {
  name: "<name>",
  description: "<one line>",
  // Optional, read statically before the run, never enforced:
  // phases: [{ title: "<phase() name>", detail: "<what this stage owns>" }],
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log, publishArtifact, awaitOperator, parallel, pipeline } = dsl;
  phase("Read");
  const findings = await agent("…one stage task…");
  return { ok: true, findings };
}
```

Four rules decide whether the file works at all:

- **Use `dsl` only.** Everything a stage needs is on that object. The runtime
  does not enforce this — see the trust note below — it is the authoring
  contract that keeps a script portable and replayable.
- **Take time and randomness from `dsl.now()` / `dsl.random()`**, never
  `Date.now()`, `new Date()`, or `Math.random()`. A direct clock call is not
  rejected; it silently makes the run unrecordable, so `--resume` can no longer
  replay it.
- **Keep the default identity.** Static `node:` imports only. Local, package, or
  dynamic imports require the literal `meta.identityCoverage: "entry-only"`
  downgrade, which binds the entry bytes and nothing else.
- **Fail closed.** Declare shape in `agent({ schema })`, put cross-field
  agreement in `validate` on the same call, and reserve `throw` for
  self-reported status and evidence this child did not produce.

**Trust note, stated plainly:** workflow JavaScript executes as reviewed trusted
local code with full Node.js capability. Worktrees, identity hashes, and `exec`
approval are evidence and consent records. This package does **not** sandbox
workflow code. Run only files you have read.

## 6. Read next

Relative to this skill's own directory:

- `../../extensions/workflows/AUTHORING.md` — the authoring pointer, with the
  full resolution, result, artifact, and replay contract.
- `../../docs/extensions/active/workflows.md` — the canonical source of truth for
  the DSL, options, trust model, and every command surface.
- `../../extensions/workflows/references/patterns.md` — stage patterns worth
  copying.
- `../../extensions/workflows/examples/README.md` — what each shipped example
  demonstrates, and which one to read for the shape you need.

To have one written for you, delegate to the catalog agent: `/agent run
workflow-author`, or the `task` tool with `{ agent: "workflow-author", task:
"<requirement>" }`.
