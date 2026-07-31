# plan-implement

Carries out one plan that a [`plan`](../plan/README.md) run produced and its
critic accepted. It first publishes the selected steps as
`implementation-tasks.md`, then processes one task at a time: a write-capable
implementer changes the checkout, an independent read-only reviewer accepts,
requests one bounded repair, or blocks the task, and only an accepted task lets
the next one start. A final read-only agent returns a validated structured grade
for every selected step; deterministic code combines that grade with the full
task ledger to account for unselected steps in the reader-facing report. The same
grade updates the authoritative selected-task state. If it proves selected work
is partial, one bounded reconciliation receives only those partial rows, checks
and grading run again, and a second partial or blocked grade ends the workflow as
non-success.
The reporter judges only the operator request and the accepted plan: when a
read-only stage cannot rerun an otherwise evidenced command, it records that
limitation under checks instead of inventing a new completion requirement.

The pair is documented together in [`../plan/README.md`](../plan/README.md) —
read it before running this one. Two things matter most:

- **The plan may be a continuation, pasted text, or one file path.** A single
  continuation remains strongest because the host verifies and copies its bytes,
  but its artifact name is irrelevant. Without a continuation, a read-only
  resolver treats the input as complete plan text or reads the named file, then
  returns the exact plan before deterministic step parsing begins.
- **This workflow writes to the launch checkout.** It is a Package workflow, so
  `/workflow-run plan-implement "<request>"` resolves by name, and
  workflow JavaScript is trusted local code with full Node.js host access. Unlike
  its read-only `plan` sibling, this one changes files — start it deliberately.
- **Resume does not apply completed tasks again.** Stable stage labels and
  deterministic task-ledger updates let
  `/workflow-run plan-implement --resume <runId> "<request>"` replay recorded
  agent answers before continuing from the unfinished task.
- **Every stage uses the same route, and the route is yours.**
  `modelRole: "agent"` names a tier instead of a provider, so the pair runs on any
  Pi installation: assign `AGENT` in `/model-roles` to choose the model and its
  reasoning effort, or assign nothing and every stage runs on the current session
  model with the degradation recorded in the run evidence.

Direct input examples:

```text
/workflows run plan-implement docs/accepted-plan.md
/workflows run plan-implement "<complete pasted plan>"
```
