# plan-implement

`plan-implement` executes exactly one complete step from `steps.md`. The caller
supplies that step as semantic input; one implementation agent inspects the live
project, makes only that change, verifies it, and records the result.

```text
one exact ## S<n> step
  → implementation agent
      → project changes or requested evidence
      → history/S<n>.md
      → exact final Markdown
```

The workflow does not accept a whole plan for script-side selection. It has no
step parser, selector, ledger, loop, reviewer, reconciliation stage, report
renderer, nested workflow, or model pin. The main Pi agent owns the dynamic todo
queue and starts one top-level run per step.

## Input and workspace

The input is one complete flat `## S<n> — ...` block copied from the frozen
`steps.md` catalog. The block has one structural heading and no nested
structural headings. Its labeled prose or bullets embed work-unit identity,
decomposition boundary, exact goal, paths and evidence, dependencies, allowed
ownership, verification, and done condition. The run must use the same workflow
workspace as `plan`, normally an explicit `tmp/<select-name>` selected through
the `workflow` tool.

The implementation agent reads `plan.md`, `steps.md`, and existing history from
that workspace. It implements the exact block directly and stops blocked rather
than widening `Allowed ownership:` or recursively decomposing the task. Project
edits happen in `pwd`; workflow records stay under the workspace.

For a step keyed `S3`, the agent fully replaces `history/S3.md` with:

- the step title;
- `Status: completed` or `Status: blocked`;
- changed files or produced evidence;
- checks and their outcomes;
- remaining blockers or risks.

The agent returns the complete history Markdown. JavaScript does not reinterpret
the status. The calling agent must read the result and mark its todo complete
only after required checks succeeded.

## Failure and recovery

Each step is a separate workflow run. If `S3` fails or reports blocked, `S1` and
`S2` remain complete, `S3` remains active, and `S4` is not started. Retry only
`S3`; do not replay earlier successful step runs.

After a Pi session restart, the main agent reads `steps.md` and `history/*.md`
and reconstructs the todo queue semantically. No JavaScript parser or durable
task ledger is involved.

Use the installed `locus-task-workflow` skill for the complete orchestration and
recovery protocol.

Plan Implement has no per-step reviewer. If an operator chooses the separate
generated-workflow path, a normal authoring request writes Design, reviews it,
and Builds the matching workflow continuously. The agent pauses after Design
only when the user explicitly asks for `Design only` or a pause; there is
no agent-injected `Design only` or approval turn, and it must not create a
separate Build request. This behavior belongs to the project-local
`workflow-author` Design, not to this Package workflow.

## Boundaries

- The implementation agent may edit the launch checkout but must preserve
  unrelated dirty work.
- It must not stage, commit, push, open a pull request, merge, deploy, mutate a
  remote, stash, or discard user changes.
- Calls use Pi's default workflow agent and its configured model route; the
  workflow source names no provider, model, model role, or specialized agent.
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
