# task workflows

`task` is a group-only Package namespace. It is not runnable by itself; use
`task/plan` to prepare a task, and `task/implement` to execute one approved step.
The shared prefix makes the relationship visible without pretending that
planning approval and implementation are one automatic run. The one-run
alternative lives beside the namespace as the separate root workflow
`task-via-script`, which runs this same planning pipeline as its own stage and
then renders a sequential implement script.

## `task/plan`

`task/plan` is the planning half of the shipped task workflow. It accepts one
task and runs a deliberately decomposed pipeline so that every stage stays
small enough for a weak model: structure carries the run, model strength only
accelerates it.

```text
task
  → scope agent            → request.md, scope.md
  → context agent          → context.md
  → three parallel analyses
      → analysis/task-semantics.md
      → analysis/repository-integration.md
      → analysis/verification-strategy.md
  → compose agent          → plan.md, step-1.md … step-<n>.md
  → three parallel reviews
      → reviews/plan-correctness.md
      → reviews/repository-integration.md
      → reviews/step-usability.md
  → correction agent       → one bounded correction of plan and step files
  → verification agent     → verification.md
  → runtime choice         → ready | blocked
      ready   → publish plan.md
      blocked → blocker agent → publish planning-blocker.md
```

There is no Markdown parser, todo manager, script renderer, or model pin in the
script. The agents inspect and write; JavaScript orders the calls, holds the
two parallel barriers, and routes the one final choice.

**The run never asks the operator.** Every agent works under the same rule:
missing evidence or an open decision becomes an explicit assumption or an exact
pre-implementation prerequisite inside the planning files, and no concrete
project value is ever invented. There is no operator gate and no continuation
run, so an automated caller can always run planning to completion. When the
final verification still finds the plan unusable, the run fails closed:
`planning-blocker.md` becomes the published primary file, the result says
BLOCKED, and the owner edits the task or the files and reruns.

**The run stops there either way.** `task/plan` implements nothing and starts
nothing. It writes files and returns a result that says so. Execution is a
separate act the owner takes after reading `plan.md` and the `step-<n>.md`
files.

## Workspace files

Every stage receives the same project-local workflow workspace. It defaults to
`<pwd>/tmp/plan/`; a caller using the `workflow` tool can select a shared
directory such as `tmp/cron-to-dag`.

- `request.md` — the exact task, byte-for-byte.
- `scope.md` — the verbatim request plus outcome, targets, boundary,
  exclusions, and open questions.
- `context.md` — repository facts, relevant files, constraints, and unknowns.
- `analysis/*.md` — the three independent analyses behind the plan.
- `plan.md` — coherent top-level work units followed by outcome, approach,
  assumptions and prerequisites, dependencies, exclusions, and verification.
- `step-<n>.md` — the executable task catalog, one file per step in execution
  order. Each file is one complete flat `## S<n> — ...` block with enough
  context for one fresh implementation agent; the `S<n>` in the heading matches
  the `<n>` in the file name.
- `reviews/*.md` — the three independent reviews of the proposed plan.
- `verification.md` — the final standalone check with its ready or blocked
  conclusion.
- `planning-blocker.md` — written only when the run fails closed; names what
  failed and what the owner can change before rerunning.

The pipeline fully replaces its assigned files on every successful run,
deleting leftover step files a new shorter catalog does not replace. A selected
workspace name is not a run id or audit id; callers may reuse it when they
intend to replace the plan.

**The files on disk are the contract.** After planning, the owner may edit
`plan.md` and any `step-<n>.md` before execution; `task/implement` and
`task-via-script` read whatever the files say at run time and add no freshness
or integrity checks. Deliberate owner edits are a feature; keeping the edited
catalog coherent is the owner's responsibility.

## Decomposition contract

`plan.md` defines top-level work units before the `step-<n>.md` catalog
decomposes them. One work unit owns a migration domain or responsibility
boundary. The analyses inform those units, but the compose agent reconciles the
result into one owner-readable plan and freezes the final task catalog before
execution.

Every executable task is one flat block with exactly one structural heading:
`## S<n> — <short title>`. It has no nested structural headings. Labeled prose
or bullets inside the block carry its work-unit identity, decomposition
boundary, exact goal, paths and evidence, dependencies, allowed ownership,
verification, and done condition. The `step-<n>.md` files stay the only
executable catalog; there is no `steps.md` or `tasks.md`.

Choose the boundary that preserves one coherent, independently verifiable
outcome:

- **File boundary** — isolated ownership of one file.
- **Function boundary** — one behavior and its local callers.
- **Behavior boundary** — one observable contract crossing files.
- **Side-effect boundary** — database, API, email, file, or subprocess work.
- **Ownership boundary** — configuration, common, or platform modules.

Do not enumerate every tiny operation in one handoff. Do not combine unrelated
work merely to reduce task count. If analysis changes the catalog, rerun
`task/plan` and deliberately replace the queue before execution, or edit the
step files deliberately as the owner; never mutate the catalog implicitly.

## Execution choices

Nothing below happens until the operator has read the planning files and asked
for it. A finished `task/plan` run is a document, not a queued job.

Default execution remains main Pi todo state plus one top-level
`task/implement` run per step file, each run given only the step id such as
`S1`. The installed `locus-task-workflow` skill owns that orchestration;
neither Package workflow parses the catalog or dispatches another workflow.

The one-run route is the separate root workflow `task-via-script`: it runs this
same planning pipeline as its own stage — over an empty workspace or replanning
across an existing one while preserving compatible owner edits — and then
renders `implement.workflow.mjs`, which the owner reviews and runs by explicit
path. See `../task-via-script/README.md`.

For a graph the fixed template does not express, send `workflow-author` a
normal authoring request: `Author a sequential project-local workflow from the
approved plan.md and step-<n>.md catalog in this workflow workspace.`
The author writes Design,
reviews it, and Builds matching source in the same turn. Do not inject
`Design only` or a second Build request;
only the user may separately request a pause after design. Plan writes only planning files into
the workflow workspace and never writes a registered project workflow. Any
optional reviewer after a generated step belongs to the bespoke design, not to
Task Plan or Task Implement execution semantics.

## Run and resume

Direct command use keeps the default workspace:

```text
/workflows run task/plan Move the cron job into a DAG
/workflows run task/plan --resume <runId> Move the cron job into a DAG
/workflows run task/implement --output-dir tmp/cron-to-dag -- S1
```

Resume requires unchanged workflow source and input. The runtime replays every
completed answer and reruns the first unfinished call, so a `task/plan` run
that failed in review replays scope, context, the analyses, and compose.
Workspace files survive a failed run, so the agents can replace incomplete
outputs.

For the complete `task/plan → session todos → one task/implement run per step`
protocol, use the installed `locus-task-workflow` skill. It calls the Package
workflows with the same explicit `tmp/<select-name>` workspace.

## `task/implement`

`task/implement` executes exactly one approved step. Its input is a step
selector — a step id such as `S1`, a file name such as `step-3.md`, or a bare
number — never the step text itself. One implementation agent resolves the
matching `step-<n>.md` in the workspace, treats that file on disk as the step
contract, reinspects the live project, changes only that step's allowed scope,
runs its checks, and fully replaces `history/S<n>.md` with `Status: completed`
or `Status: blocked`.

The workflow does not accept a whole plan and does not select or loop over
steps. It has no parser, todo manager, reviewer, report renderer, nested
workflow, or model pin. Main Pi owns the dynamic todo queue and starts one
top-level `task/implement` run per step file, always with the same explicit
workflow workspace used by `task/plan`.

If one step fails or reports blocked, earlier histories stay complete and later
steps do not start. Retry only the active step. The implementation result is
returned unchanged; the caller marks a todo complete only after the history
records successful required checks.

`task/implement` is intentionally different from the separate `implement`
workflow. `task/implement` executes one approved planning step; `implement`
applies selected findings from a post-code review.

## Boundaries

- Planning agents are instructed not to modify project files and not to run any
  step; the run never waits for an operator answer and fails closed instead.
- Calls use Pi's default workflow agent and its configured model route; the
  workflow source names no provider, model, model role, or specialized agent.
- A missing task or step selector is handed to the agents as an explicit
  blocking input gap; they must not invent implementation work.
- The catalog is frozen by planning and changed only deliberately: a new
  `task/plan` run replaces it, and owner edits to `step-<n>.md` are the owner's
  explicit act. The workflows add no freshness or integrity checks on top.
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
