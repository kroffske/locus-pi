# plan-implement

Carries out one plan that a [`plan`](../plan/README.md) run produced and its critic
accepted: one write-capable agent per plan step, then independent checks and a
fresh report against the original plan.

The pair is documented together in [`../plan/README.md`](../plan/README.md) —
read it before running this one. Two things matter most:

- **The plan arrives as host-verified continuation bytes**, not as text in the
  input. The entry requires exactly one artifact named `plan.md` and proves it was
  the terminal result of a successful `plan` `draft-plan` run.
- **This workflow writes to the launch checkout.** It is a Package workflow, so
  `/workflow-run plan-implement "<request>"` resolves by name, and
  workflow JavaScript is trusted local code with full Node.js host access. Unlike
  its read-only `plan` sibling, this one changes files — start it deliberately.
