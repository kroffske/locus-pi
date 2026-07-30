# plan-implement

Carries out one plan that a [`plan`](../plan/README.md) run produced and its
critic accepted. It first publishes the selected steps as
`implementation-tasks.md`, then processes one task at a time: a write-capable
implementer changes the checkout, an independent read-only reviewer accepts,
requests one bounded repair, or blocks the task, and only an accepted task lets
the next one start. A final read-only agent returns a validated structured grade
for every plan step; deterministic code turns that grade into the reader-facing
report and the authoritative task ledger. If the grade proves that selected work
is partial, one bounded reconciliation receives only those partial rows, checks
and grading run again, and a second partial or blocked grade ends the workflow
as non-success.
The reporter judges only the operator request and the accepted plan: when a
read-only stage cannot rerun an otherwise evidenced command, it records that
limitation under checks instead of inventing a new completion requirement.

The pair is documented together in [`../plan/README.md`](../plan/README.md) —
read it before running this one. Two things matter most:

- **The plan arrives as host-verified continuation bytes**, not as text in the
  input. The entry requires exactly one non-empty artifact named `plan.md`; the
  host verifies and copies the referenced bytes. The entry deliberately does not
  re-prove which drafting round produced them, so the operator must continue from
  the accepted `plan` result rather than an earlier same-named draft.
- **This workflow writes to the launch checkout.** It is a Package workflow, so
  `/workflow-run plan-implement "<request>"` resolves by name, and
  workflow JavaScript is trusted local code with full Node.js host access. Unlike
  its read-only `plan` sibling, this one changes files — start it deliberately.
- **Resume does not apply completed tasks again.** Stable stage labels and
  deterministic task-ledger updates let
  `/workflow-run plan-implement --resume <runId> "<request>"` replay recorded
  agent answers before continuing from the unfinished task.
- **Every stage uses the same concrete runtime.**
  `openai-codex/gpt-5.6-luna:medium` pins both the model and child reasoning
  effort; the workflow fails closed if this Pi installation cannot resolve it.
