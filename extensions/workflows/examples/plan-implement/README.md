# plan-implement

Carries out one plan that a [`plan`](../plan/README.md) run produced and its
critic accepted. It first publishes the selected steps as
`implementation-tasks.md`, then processes one task at a time: a write-capable
implementer changes the checkout, an independent read-only reviewer accepts,
requests one bounded repair, or blocks the task, and only an accepted task lets
the next one start.

The pair is documented together in [`../plan/README.md`](../plan/README.md) —
read it before running this one. Two things matter most:

- **The plan arrives as host-verified continuation bytes**, not as text in the
  input. The entry requires exactly one artifact named `plan.md` and proves it was
  the terminal result of a successful `plan` `draft-plan` run.
- **This workflow writes to the launch checkout.** It is a Package workflow, so
  `/workflow-run plan-implement "<request>"` resolves by name, and
  workflow JavaScript is trusted local code with full Node.js host access. Unlike
  its read-only `plan` sibling, this one changes files — start it deliberately.
- **Resume does not apply completed tasks again.** Stable stage labels and
  deterministic task-ledger updates let
  `/workflow-run plan-implement --resume <runId> "<request>"` replay recorded
  agent answers before continuing from the unfinished task.
