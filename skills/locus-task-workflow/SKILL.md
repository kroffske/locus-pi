---
name: locus-task-workflow
description: Plan one task into workspace files, then implement its dynamic steps one at a time with Package workflows and session todos.
---

# Locus task workflow

Use this skill when the user wants a task planned and carried out through the
shipped `plan` and `plan-implement` Package workflows.

The main Pi agent owns orchestration. Workflow children do not spawn more
agents. Workflow JavaScript does not parse plans or manage the todo queue.

## Start or replan

1. Keep the user's complete task text unchanged.
2. Choose one short stable `select-name`, or use the name the user supplied.
   It must match `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`.
   The shared workflow workspace is `tmp/<select-name>`. Do not add a timestamp,
   run id, audit id, or another nesting level. Reusing a name is allowed when the
   user intends to replace that workspace's planning files.
3. Call the `workflow` tool with:
   - `name: "plan"`
   - `input: <complete task text>`
   - `outputDir: "tmp/<select-name>"`
4. If planning fails after a run id is available, retry the same workflow with
   the same `input` and `outputDir` plus `resumeFromRunId: <failed run id>`.
   Do not invent a planning ledger: replay owns completed agent calls.
5. Read `tmp/<select-name>/plan.md` and `tmp/<select-name>/steps.md`. Stop if
   either file is missing, empty, or does not describe an executable task.

## Create the execution queue

Read `steps.md` semantically. Create one single-line todo reference per complete
`## S<n> — <title>` step block. Keep the full block in `steps.md`; do not put
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
references with `steps.md` and `history/`; do not append duplicates.

Derive each reference only from its step id and heading title. Do not summarize,
merge, renumber, split, or copy the body into the todo. If a step is too broad,
rerun `plan`; do not hide a second planning system here.

## Execute one todo

For the single active workflow todo:

1. Match its `S<n>` reference to `steps.md` and read that complete step block
   just in time. Do not rely on a remembered or summarized copy.
2. Call the `workflow` tool with:
   - `name: "plan-implement"`
   - `input: <exact complete S<n> block from steps.md>`
   - `outputDir: "tmp/<select-name>"`
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

Each reference gets a new top-level `plan-implement` run. If the host pauses
automatic execution after its 20-continuation safety limit, preserve the active
reference and tell the operator to resume with `/todo run`.

Do not call another workflow from inside either Package workflow. Do not use
`items`, `pipeline`, or `invokeWorkflow` for this protocol.

## Resume in a new session

Read `steps.md` and every existing `history/*.md`. Recreate the dedicated phase
from the one-line step references, marking only steps with a credible
`Status: completed` history and successful required checks as complete. Keep a
blocked or missing reference active, then read its exact block from `steps.md`
when execution resumes. This is an agent reading task documents, not a
JavaScript parser.

If the user changed the task or step list, rerun `plan`, review the replacement
files, and deliberately rebuild todos. Keep old history as evidence unless the
user asks to remove it.

## Finish

After all todos are complete, read `plan.md` and `history/*.md`, then fully
replace `tmp/<select-name>/result.md` with a concise account of the delivered
outcome, changed files or produced evidence, checks, and remaining risks. Tell
the user where `plan.md`, `steps.md`, `history/`, and `result.md` live.
