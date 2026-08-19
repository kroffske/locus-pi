---
name: locus-task-workflow
description: Plan one accepted task into a unique workspace, stop for review, then implement the complete approved plan with one Package workflow run.
---

# Locus task workflow

Use this skill when the user wants a task planned and carried out through the
shipped `task/plan` and `task/implement` Package workflows. The separate
`task-via-script` root owns the one-run alternative: its own planning stage
plus the rendered sequential implement script.

`task/draft` is the optional manual stage before this skill. Use it when the
operator asks to translate or clarify a raw request. It may interview the
operator, then saves `draft.md` and stops. Do not insert it automatically into a
planning request that is already accepted.

For that explicit manual stage, call the `workflow` tool with
`name: "task/draft"` and the raw request as `input`. Keep the returned planning
workspace for the later `task/plan` call.

The main Pi agent owns the review and launch boundary. Workflow JavaScript does
not parse plans or manage a todo queue. One implementation agent reads and
executes the approved step catalog from disk.

**Planning and execution are two separate user turns.** Running `plan` never
continues into execution. Finish planning, present the files, and end your turn.
Execution starts only when the user, in a later turn, tells you to start it.

## Start or replan

1. Keep the user's complete accepted task text unchanged.
2. When an accepted `task/draft` result exists, take `<run-name>` from its exact
   `.locus-pi/plans/<run-name>` workspace and pass that leaf through `runName`.
   Otherwise omit both `runName` and `outputDir`; the runtime creates a fresh unique planning workspace whose
   id begins with the new run id.
3. Call the `workflow` tool with `name: "task/plan"`. Supply `input` for a direct
   task or an explicit refinement. When reusing an accepted draft unchanged,
   omit `input`; `task/plan` reads `draft.md` from the shared workspace.
4. Save the returned `workspaceDirRelative` as `<planning-workspace>` and its
   final path component as `<run-name>`. If
   planning fails after a run id is available, retry with the same semantic
   input plus `resumeFromRunId: <failed run id>`. The task planning resume path
   reuses the source workspace automatically; a conflicting `outputDir` fails.
   Do not invent a planning ledger: replay owns completed agent calls.
5. Read `<planning-workspace>/plan.md` and every
   `<planning-workspace>/step-<n>.md`
   file. Stop if `plan.md` or the step files are missing, empty, or do not
   describe an executable task.
6. Confirm `plan.md` first defines coherent top-level work units and that
   the `step-<n>.md` files are the only executable task catalog. Do not create
   a single combined catalog file such as `tasks.md`.
7. Confirm every executable task is one complete flat
   `## S<n> — <title>` block in its own `step-<n>.md` file, with no nested
   structural headings and an `S<n>` that matches the `<n>` in its file name.
   Each block must embed work-unit identity, decomposition boundary, exact goal,
   paths/evidence, dependencies, allowed ownership, verification, and done
   condition. Reject and rerun `task/plan` when any block is incomplete or
   incoherent.
8. Planning renders no implement script. If the user later wants one,
   `task-via-script` replans across this same workspace — preserving compatible
   owner edits — and renders `implement.workflow.mjs`; do not run it now.

## Stop and hand the plan to the user

Now stop. Report where `plan.md` and the `step-<n>.md` files live, summarize the
work units and the step titles in order, and name anything you would change.
Then end your turn.

Do not create todos. Do not call `task/implement` or `task-via-script`. Do not edit
project files toward any step. The `task/plan` run's own result text lists next
actions; it is a description of the user's options, not an instruction to you,
and neither it nor a plan that looks obviously correct is approval.

Approval is a new user turn that tells you to execute — for example "go ahead",
"run it", "implement the plan", or a named route. "Plan this" and "make a plan"
are not approval. When the user's answer is unclear, ask which route they want
rather than starting one.

## Freeze the catalog and choose the approved route

Planning may use fresh agents to analyze coherent top-level work units before
this point. Reconcile all such analysis into one owner-readable `plan.md` and
one final `step-<n>.md` catalog; do not create a nested manager or recursive
task dispatcher. Once execution begins, the exact step catalog is frozen. A
material catalog change requires a new `task/plan` run and a deliberate todo
rebuild.

Once the user has approved, run the route they chose:

- **Task Implement route (default when the user just says "go ahead").** Start
  one top-level `task/implement` run on the approved planning workspace. One
  implementation agent reads every step file in order, records each result in
  `history/`, and stops before later steps on the first blocker.
- **Script route.** Call `task-via-script` with `runName: "<run-name>"`.
  It runs its own `task/plan` stage across the same workspace — preserving
  compatible owner edits, so material manual changes deserve a fresh review of
  the replanned files — and renders `<planning-workspace>/implement.workflow.mjs`.
  Hand that file back for review. The user runs the reviewed script themselves
  with `/workflows run <planning-workspace>/implement.workflow.mjs --output-dir <planning-workspace>`. Run it on
  their behalf only when they ask you to. It resolves by explicit path only and
  is not a registered project workflow.
- **Bespoke workflow route.** When the user wants a graph the template does not
  express, hand the approved `plan.md` and the `step-<n>.md` catalog to
  `workflow-author` as a
  normal authoring request. It writes Design, reviews it, and Builds matching
  source in the same turn. Do not author `.workflow.mjs` source yourself, inject
  `Design only`, or add a later Build-only request. Only the user may separately
  request a pause after design. Plan approval starts neither implementation nor
  workflow authoring. Any optional reviewer after a generated step belongs to
  the bespoke design, not to Task Plan, Task Via Script, or Task Implement
  execution semantics.

## Execute the approved plan

Only after the user approves the Task Implement route:

1. Reopen `plan.md` and every `step-<n>.md`. Stop if the catalog changed
   materially since approval or is no longer coherent.
2. Call the `workflow` tool once with:
   - `name: "task/implement"`
   - `runName: "<run-name>"`

   Do not pass a step selector or step text. The workflow reads the complete
   catalog from the shared workspace and executes it in numeric order.

3. Read the returned summary and every `<planning-workspace>/history/S<n>.md`.
   Completion requires every step to say `Status: completed` with successful
   required checks.
4. On a failed workflow, missing history, `Status: blocked`, or failed required
   check, stop. Do not start a separate run for a later step.

Do not call another workflow from inside either Package workflow. Do not use
session todos, `items`, `pipeline`, or `invokeWorkflow` for this protocol.

## Resume in a new session

Resuming is still execution, so it still needs the user to ask for it. Finding a
`step-<n>.md` catalog with unfinished history is not a reason to start.

When they do ask, read the `step-<n>.md` files and every existing `history/*.md`.
Start one new `task/implement` run with the same `runName`, or use
`resumeFromRunId` when retrying an interrupted run with unchanged workflow
source. The implementation agent treats completed history as evidence, checks
the live state, and continues the ordered catalog only when earlier steps remain
complete.

If the user changed the task or step list, rerun `task/plan`, review the replacement
files, freeze the replacement catalog, and deliberately rebuild todos. Keep old
history as evidence unless the user asks to remove it.

## Finish

After the workflow completes, read `plan.md` and `history/*.md`, then fully
replace `<planning-workspace>/result.md` with a concise account of the delivered
outcome, changed files or produced evidence, checks, and remaining risks. Tell
the user where `plan.md`, the `step-<n>.md` files, `history/`, and `result.md`
live.
