# task-via-script

`task-via-script` is the one-run route from a task to a runnable sequential
implement script. It is a separate root workflow, not a `task/` child, because
it owns its whole route: it runs the full `task/plan` pipeline as its own
planning stage and then renders the script from the files that stage wrote. The
step-by-step route (`task/plan` reviewed by the owner, then one
`task/implement` run per step) exists independently; the two routes can be
compared on the same task.

```text
task
  → invokeWorkflow task/plan        (the full decomposed planning pipeline)
      ready   → scripting agent     → implement.workflow.mjs
      blocked → publish planning-blocker.md, no script
  → publish implement.workflow.mjs
```

## Planning stage

The planning stage is a real depth-one saved-child run of `task/plan` in this
workflow's own workspace: scope freeze, live context, three parallel analyses,
compose, three parallel reviews, one bounded correction, final verification,
and the ready/blocked route. It never waits for an operator; unknowns become
explicit assumptions and prerequisites inside `plan.md`. See
`../task/README.md` for the pipeline and the workspace file contract.

Run over an empty workspace, the stage plans from scratch. Run over a workspace
that already holds planning files, it replans across them and preserves
compatible owner edits — so an owner who has already reviewed and edited a
`task/plan` result can point `task-via-script` at the same workspace to get the
script for the updated catalog.

When planning fails closed, `task-via-script` publishes `planning-blocker.md`
itself and renders nothing.

## Rendering stage

One scripting agent reads `plan.md` and the frozen `step-<n>.md` catalog from
the workspace and fully replaces `implement.workflow.mjs`.
`resources/implement-template.prompt.md` holds both the agent's charter and the
fixed source template it fills. The agent substitutes only a description, each
step id, each step title, and each verbatim `## S<n>` block; it changes nothing
else, and it deletes a stale generated `execute.workflow.mjs` when one exists.
The result is one `phase()`/`log()`/`agent()` group per step file in catalog
order, then a summary agent that writes `result.md` from `plan.md` and
`history/*.md`, then `publishPrimaryFile("result.md")`.

Every step prompt is literal author-known text, so the generated script parses
no catalog at runtime. Each step prompt reads its own `history/S<n>.md` first
and returns the existing record unchanged when that step is already credibly
complete, which is what makes rerunning the script safe after a failed step.

The template deliberately omits loops, reviewers, retries, parsers, schemas,
`try`/`catch`, and nested workflows. A graph that needs any of those goes to
`workflow-author` as a normal authoring request instead.

## Where the script lives and how it runs

Two boundaries hold the trust line:

- The generated script is written to the workflow workspace, never to
  `.pi/workflows/`, `.claude/workflows/`, or `.agents/workflows/`. It is not a
  registered workflow, cannot shadow or overwrite a saved workflow, and does
  not resolve by bare name — only
  `/workflows run <workspace>/implement.workflow.mjs --output-dir <workspace>`
  reaches it without losing `plan.md` or `history/`.
- Running it is the owner's explicit act. Workflow JavaScript runs in Pi's main
  Node.js process with full filesystem, subprocess, and network authority, so
  read the file before running it. Approving a plan is not approving a run, and
  rendering is not approval to run.

## Run

```text
/workflows run task-via-script -- Move the cron job into a DAG
/workflows run .locus-pi/plans/<run-name>/implement.workflow.mjs --output-dir .locus-pi/plans/<run-name>
```

To render from an already reviewed task workspace, pass that exact
`.locus-pi/plans/<run-name>` path through `--output-dir` instead.

The second command is the owner's separate act after reading the rendered
file. Resume follows the normal rules: the planning stage is checkpointed as a
saved child, so a rerun after a rendering failure replays planning instead of
repeating its model calls.
