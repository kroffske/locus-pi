# plan-implement

Carries out one outcome-first plan that a [`plan`](../plan/README.md) run
produced and its critic accepted. The plan must declare one primary result, who
uses it, where it will exist, what makes it useful, and how usefulness is
proved. The workflow first publishes the selected steps as
`implementation-tasks.md`, then processes one task at a time: a write-capable
implementer changes the checkout, an independent read-only reviewer accepts,
requests one bounded repair, or blocks the task, and only an accepted task lets
the next one start. A final read-only agent returns a validated structured grade
for every selected step; deterministic code combines that grade with the full
task ledger to account for unselected steps in the reader-facing report. The same
grade updates the authoritative selected-task state. The check stage returns
structured status for every selected verification and repository-wide command
it ran. Deterministic validation refuses success after any failed or unrun check,
an evidence gap, a run-attributable unexpected change, or a primary result that
is not ready. `Depends on:` is parsed and subset selection is rejected until all
declared predecessors are included. One bounded reconciliation may repair those
terminal gaps, including a missing result even when every individual step row
was already done; a second partial or blocked grade ends as non-success.

The primary output is `workflow-summary.md`: it names the useful result, its
location, readiness, meaning, and proof. `implementation-report.md` and
`implementation-tasks.md` are supporting technical evidence rather than the
result itself.

The pair is documented together in [`../plan/README.md`](../plan/README.md) —
read it before running this one. Two things matter most:

- **The plan may be a continuation, pasted text, or one file path.** A single
  continuation remains strongest because the host verifies and copies its bytes,
  but its artifact name is irrelevant. Without a continuation, deterministic
  workflow code passes multiline input through as plan text or reads the named
  text file before structural step parsing begins. Agents own the plan's meaning
  and the final judgment; the script only extracts routing structure.
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
