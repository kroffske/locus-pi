---
name: locus-pi-workflow-implement-task
description: Implement one accepted task through the locus-pi plan, owner review, render, owner approval, execution, and explicit recovery lifecycle. Owns stage boundaries, not generic workflow-run transport.
---

# Implement a task through locus-pi workflows

Use this skill when the user wants a task planned and carried out through the
shipped `task/plan`, `task/implement-plan-template`, and optional
`task/substep` Package workflows.

This skill owns the task lifecycle and its approval boundaries. For the mechanics
of one workflow launch, typed receipts, monitoring, or resume, use
`locus-pi-workflow-run`; do not duplicate or weaken that transport contract here.

Inside Pi, launch each named stage with the native `workflow` tool. From Codex,
Claude Code, or another shell-capable agent, launch the same stage through Pi:

```text
prompt = "/workflows run task/plan -- <accepted task>"
["pi", "--mode", "json", "-p", "--no-session", "--approve",
 "--model", "<provider/model>", "--thinking", "high", prompt]
```

Use a process API and never interpolate the task as shell syntax. This first
planning run deliberately omits `--run-name`; reuse an accepted draft by adding
its existing `--run-name <name>`. Use the run skill to construct the exact
command and interpret typed receipts.
Select the main Pi model with `--model` and `--thinking`; configure child model
roles separately with `/model-roles` or `.pi/model-roles/config.json`.
Whenever the steps below say to call the `workflow` tool, that is the native Pi
route. Outside Pi, express the same target and fields through the run skill's
external command route; stop if a required field is native-only.

`task/draft` is the optional manual stage before planning. Use it only when the
operator asks to translate or clarify a raw request. Call the `workflow` tool
with `name: "task/draft"` and the raw request as `input`, then retain the
returned planning workspace.

The main Pi agent owns every review and launch boundary. Package workflow source
does not parse the plan. The generated `implement-plan.workflow.mjs` contains
one literal implementation node per approved step.

**Planning, rendering, and execution are separate user turns.** A completed
`task/plan` is not approval to render. A rendered workflow is trusted
JavaScript and is not approval to run.

## Start or replan

1. Keep the user's complete accepted task text unchanged.
2. Reuse an accepted draft's `.locus-pi/plans/<run-name>` workspace through
   `runName`. Otherwise omit `runName` and `outputDir`; the runtime creates a
   unique planning workspace.
3. Call the `workflow` tool with `name: "task/plan"`. Supply `input` for a
   direct task or explicit refinement. Omit it when an accepted `draft.md`
   already owns the direction.
4. Save `workspaceDirRelative` as `<planning-workspace>` and its final path
   component as `<run-name>`. Retry an interrupted unchanged run with
   `resumeFromRunId`; task resume reuses its original workspace.
5. Read `plan.md` and every `step-<n>.md`. Require a contiguous ordered
   catalog whose file number matches its complete flat
   `## S<n> — <title>` heading. Each step must carry its goal, boundary,
   dependencies, allowed ownership, verification, and done condition.
6. Stop on a missing, empty, or incoherent plan. Do not invent a combined
   `tasks.md` catalog or repair the plan during implementation.

## Stop and hand the plan to the user

Report `plan.md`, the ordered step titles, the planning workspace, and anything
that still needs owner correction. Then end the turn.

Do not render `implement-plan.workflow.mjs`, execute project changes, create
todos, or call `task/substep`. Approval must arrive in a later user turn, for
example "run it" or "implement the plan".

## Render the approved implementation plan

Only after the user approves the saved plan:

1. Reopen `plan.md` and every `step-<n>.md`. A material catalog change needs
   fresh review before rendering.
2. Call the `workflow` tool once with:
   - `name: "task/implement-plan-template"`
   - `runName: "<run-name>"`
3. Read `<planning-workspace>/implement-plan.workflow.mjs`. Confirm it has one
   literal implementation node per step in the approved order and one final
   summary node. Confirm the file names the same step titles and embeds each
   complete step block.
4. Hand that generated file to the user and end the turn. Rendering does not run
   a step and does not authorize the generated trusted JavaScript.

The renderer does not invoke `task/plan`. It applies the fixed template to the
files already approved in this workspace. A missing or malformed catalog leaves
the generated target absent and publication fails closed.

## Run the reviewed complete plan

Only after the user asks to run the generated file:

1. Call the `workflow` tool with:
   - `scriptPath: "<planning-workspace>/implement-plan.workflow.mjs"`
   - `outputDir: "<planning-workspace>"`
2. The generated graph runs `S1`, `S2`, and later nodes in order. A failed or
   blocked child stops the run before the next node. Each node fully replaces
   `history/S<n>.md` and skips only credible already-completed work.
3. Read the returned result, every `history/S<n>.md`, and `result.md`.
   Completion requires every step to say `Status: completed` with successful
   required checks.
4. On a missing history, blocked status, failed check, or failed workflow, stop
   and report the exact active step. Treat an exact `Status: blocked` record as
   terminal evidence, never as permission to continue. Never start a later step
   separately unless the user explicitly chooses manual recovery.

## Run one explicit recovery substep

`task/substep` is not a second complete-plan route. Use it only when the user
asks for one isolated step or recovery target.

Call the `workflow` tool with:

- `name: "task/substep"`
- `input: "<step id, such as S1>"`
- `runName: "<run-name>"`

Read the matching `history/S<n>.md`. Do not infer permission to run the next
step. After recovery, rerun the same reviewed `implement-plan.workflow.mjs`;
its completed-history checks make that retry idempotent.

## Resume and plan changes

Resuming is execution and still needs the user's request. Retry an interrupted
generated run with the same `scriptPath`, the same `outputDir`, and
`resumeFromRunId`.

If the user changes `plan.md` or any step after rendering, rerun
`task/implement-plan-template`, review the replacement
`implement-plan.workflow.mjs`, and obtain execution approval again. Keep old
history as evidence unless the user asks to remove it.

For a graph that needs review between steps, concurrency, or a bounded revision
loop, hand the approved plan and complete step catalog to the
`locus-pi-workflow-create` skill as a normal authoring request. It writes Design, reviews it, and Builds matching
source in the same turn. Do not inject `Design only`; only the user may request
that pause. Do not turn that bespoke route into another Package alias.

## Finish

After the complete generated workflow succeeds, tell the user where
`plan.md`, `step-<n>.md`, `implement-plan.workflow.mjs`, `history/`, and
`result.md` live. State changed files or evidence, checks, and remaining
risks.
