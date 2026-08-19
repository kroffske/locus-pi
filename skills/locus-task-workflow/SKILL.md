---
name: locus-task-workflow
description: Plan one task into workspace files, stop for the user's review, then implement the approved steps one at a time with Package workflows and session todos.
---

# Locus task workflow

Use this skill when the user wants a task planned and carried out through the
shipped `task/plan` and `task/implement` Package workflows. The separate
`task-via-script` root owns the one-run alternative: its own planning stage
plus the rendered sequential implement script.

The main Pi agent owns orchestration. Workflow children do not spawn more
agents. Workflow JavaScript does not parse plans or manage the todo queue.

**Planning and execution are two separate user turns.** Running `plan` never
continues into execution. Finish planning, present the files, and end your turn.
Execution starts only when the user, in a later turn, tells you to start it.

## Start or replan

1. Keep the user's complete task text unchanged.
2. Choose one short stable `select-name`, or use the name the user supplied.
   It must match `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`.
   The shared workflow workspace is `tmp/<select-name>`. Do not add a timestamp,
   run id, audit id, or another nesting level. Reusing a name is allowed when the
   user intends to replace that workspace's planning files.
3. Call the `workflow` tool with:
   - `name: "task/plan"`
   - `input: <complete task text>`
   - `outputDir: "tmp/<select-name>"`
4. If planning fails after a run id is available, retry the same workflow with
   the same `input` and `outputDir` plus `resumeFromRunId: <failed run id>`.
   Do not invent a planning ledger: replay owns completed agent calls.
5. Read `tmp/<select-name>/plan.md` and every `tmp/<select-name>/step-<n>.md`
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

- **Todo route (default when the user just says "go ahead").** Create the main
  Pi execution queue below and start one top-level `task/implement` run per
  exact step. It is the most recoverable route: each step is its own top-level
  run, and a failure stops the queue with the plan intact.
- **Script route.** Call `task-via-script` with `outputDir: "tmp/<select-name>"`.
  It runs its own `task/plan` stage across the same workspace — preserving
  compatible owner edits, so material manual changes deserve a fresh review of
  the replanned files — and renders `tmp/<select-name>/implement.workflow.mjs`.
  Hand that file back for review. The user runs the reviewed script themselves
  with `/workflows run tmp/<select-name>/implement.workflow.mjs`. Run it on
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

## Create the execution queue

Only after the user approved the todo route. Read the `step-<n>.md` files
semantically. Create one single-line todo reference per complete
`## S<n> — <title>` step block. Keep the full block in its file; do not put
multiline text into todo items because todo export/edit is line-oriented.

Append the references to a dedicated `Implementation · <select-name>` phase and
explicitly start the first reference. `append` preserves unrelated session
todos; never replace the whole queue with `init`. One `append.items` array holds
at most 20 references, so use multiple ordered `append` operations when needed:

```json
{
  "context": "Implement the plan in tmp/<select-name>/plan.md",
  "autoContinue": true,
  "ops": [
    {
      "op": "append",
      "phase": "Implementation · <select-name>",
      "items": ["<select-name> / S1 — <title>", "<select-name> / S2 — <title>"]
    },
    {
      "op": "start",
      "task": "<select-name> / S1 — <title>"
    }
  ]
}
```

If that dedicated phase already exists in the current session, reconcile its
references with the `step-<n>.md` files and `history/`; do not append duplicates.

Derive each reference only from its step id and heading title. Do not summarize,
merge, renumber, split, or copy the body into the todo. If a step is too broad,
rerun `task/plan`; do not hide a second planning system here.

## Execute one todo

For the single active workflow todo:

1. Match its `S<n>` reference to the matching `step-<n>.md` file and read that
   complete step block just in time. Do not rely on a remembered or summarized
   copy.
2. Call the `workflow` tool with:
   - `name: "task/implement"`
   - `input: <the step id, such as S1>`
   - `outputDir: "tmp/<select-name>"`

   Pass only the selector. The workflow resolves and reads the `step-<n>.md`
   file itself, and the file on disk is the step contract.

3. Read the returned text and the corresponding
   `tmp/<select-name>/history/S<n>.md`.
4. Mark the exact one-line reference `done` only when the history says
   `Status: completed` and its required checks succeeded. In the same
   `todo_write` call, explicitly `start` the next workflow reference and keep
   `autoContinue: true`. This keeps unrelated pending todos from entering the
   workflow sequence.
5. For the final workflow reference, mark it `done` with
   `autoContinue: false`; do not automatically resume unrelated todos.
6. On a failed workflow, missing history, `Status: blocked`, or failed required
   check, add a note to the one-line reference, set `autoContinue: false`, and stop.
   Never mark the todo done and never start the next step.

Each reference gets a new top-level `task/implement` run. If the host pauses
automatic execution after its 20-continuation safety limit, preserve the active
reference and tell the operator to resume with `/todo run`.

Do not call another workflow from inside either Package workflow. Do not use
`items`, `pipeline`, or `invokeWorkflow` for this protocol.

## Resume in a new session

Resuming is still execution, so it still needs the user to ask for it. Finding a
`step-<n>.md` catalog with unfinished history is not a reason to start.

When they do ask, read the `step-<n>.md` files and every existing `history/*.md`.
Recreate the dedicated phase from the one-line step references, marking only
steps with a credible `Status: completed` history and successful required checks
as complete. Keep a blocked or missing reference active, then read its exact
block from its `step-<n>.md` file when execution resumes. This is an agent
reading task documents, not a JavaScript parser.

If the user changed the task or step list, rerun `task/plan`, review the replacement
files, freeze the replacement catalog, and deliberately rebuild todos. Keep old
history as evidence unless the user asks to remove it.

## Finish

After all todos are complete, read `plan.md` and `history/*.md`, then fully
replace `tmp/<select-name>/result.md` with a concise account of the delivered
outcome, changed files or produced evidence, checks, and remaining risks. Tell
the user where `plan.md`, the `step-<n>.md` files, `history/`, and `result.md`
live.
