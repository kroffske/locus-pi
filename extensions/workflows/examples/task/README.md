# task workflows

`task` is a group-only Package namespace. It is not runnable by itself. Use
`task/draft` to translate a raw request, `task/plan` to prepare an accepted task,
`task/implement-plan-template` to render the approved plan into one reviewable
sequential workflow, and `task/substep` only when one named step must run by
itself. The generated `implement-plan.workflow.mjs` is the sole complete-plan
executor. Planning, rendering, generated-source approval, and execution remain
separate operator actions.

## `task/draft`

`task/draft` is the optional interactive front door. It accepts a raw request
and uses one agent to gather only request-relevant project facts. That agent
also returns the runtime-owned choice `ready | ask`. The drafting agent receives
the live `workflow_ask` tool only on the `ask` branch and is instructed to group
no more than three pivotal questions in one call. It fully replaces `draft.md`
and stops. A ready request can run headless; a no-operator or headless run fails
closed before the drafting child when clarification is required. It never
invents an answer.

The saved draft uses the Locus Prompt Draft structure. It states the task, one
working end state, relevant context, the in-scope and out-of-scope direction,
and any evidence or unresolved fragments. It is an intent mirror, not an
implementation plan. The owner reads it before starting `task/plan` manually on
the same workspace.

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

Every stage receives the same project-local workflow workspace. A fresh
`task/draft`, `task/plan`, `task/implement-plan-template`, or `task/substep` run
receives a unique default beneath `.locus-pi/plans/`, for example
`.locus-pi/plans/20260819-142530-a1b2-task-draft/`. The prefix is the run id:
a sortable UTC timestamp plus a random suffix. The workflow slug keeps the
origin visible. That folder leaf is the generated run name. A caller may instead
select `.locus-pi/plans/<name>` with `--run-name <name>`.

The manual route reuses one directory deliberately. After `task/draft`, copy
the exact `task/plan --run-name ...` command from the completion card. After
planning approval, copy the `task/implement-plan-template --run-name ...`
command. The generated workflow and every optional `task/substep` recovery run
use that same workspace.

- `draft-context.md` — the bounded reconnaissance behind an interactive draft.
- `draft.md` — the accepted intent that `task/plan` reads when present.
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
- `implement-plan.workflow.mjs` — generated only after plan approval; one
  literal implementation node per step followed by one summary node.
- `history/S<n>.md` — idempotent result of one executed step.
- `result.md` — summary published by the generated complete-plan workflow.

The pipeline fully replaces its assigned files on every successful run,
deleting leftover step files a new shorter catalog does not replace. A selected
workspace may be reused when the owner intends to refine a draft, replace a
plan, or execute its approved steps. Independent work uses a fresh planning
directory.

**The files on disk are the contract.** After planning, the owner may edit
`plan.md` and any `step-<n>.md` before rendering. The template renderer and
`task/substep` read whatever the files say at run time and add no freshness or
integrity checks. Deliberate owner edits are a feature; keeping the edited
catalog coherent is the owner's responsibility. Once
`implement-plan.workflow.mjs` is rendered, its literal step prompts remain
frozen until the owner deliberately renders it again.

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

Default execution starts by running `task/implement-plan-template` on the
approved workspace. It does not plan or replan. One scripting agent applies a
fixed template to `plan.md` and the ordered step catalog, then publishes
`implement-plan.workflow.mjs` without running it. The owner reads that generated
file and starts it by explicit path with the same workspace.

The generated file contains one literal `agent()` node per `step-<n>.md` file
in order. A failed step stops the workflow before the next node. Each node reads
its existing `history/S<n>.md` and skips only credible completed work, so the
same generated file can be retried safely. A final summary node writes and
publishes `result.md`.

`task/substep` is not another complete-plan route. It accepts one selector such
as `S1` and executes only the matching step. Use it for explicit recovery,
diagnosis, or an intentionally isolated step.

For a graph the fixed template does not express, send `workflow-author` a
normal authoring request: `Author a sequential project-local workflow from the
approved plan.md and step-<n>.md catalog in this workflow workspace.`
The author writes Design,
reviews it, and Builds matching source in the same turn. Do not inject
`Design only` or a second Build request;
only the user may separately request a pause after design. Plan writes only planning files into
the workflow workspace and never writes a registered project workflow. Any
optional reviewer after a generated step belongs to the bespoke design, not to
the fixed implement-plan template or `task/substep` semantics.

## Run and resume

Direct command use keeps the default workspace:

```text
/workflows run task/draft -- Move the cron job into a DAG
/workflows run task/draft --run-name airflow-builder -- Move the cron job into a DAG
/workflows run task/plan --run-name airflow-builder
/workflows run task/implement-plan-template --run-name airflow-builder
/workflows run .locus-pi/plans/airflow-builder/implement-plan.workflow.mjs --output-dir .locus-pi/plans/airflow-builder
/workflows run task/substep --run-name airflow-builder -- S1
/workflows run task/plan Move the cron job into a DAG
/workflows run task/plan --resume <runId> Move the cron job into a DAG
```

Resume requires unchanged workflow source and input. For task planning targets,
`--resume <runId>` reuses the source workspace even when the original run chose
it explicitly; repeating `--output-dir` is optional, and a conflicting path is
refused. The runtime replays every completed answer and reruns the first
unfinished call, so a `task/plan` run that failed in review replays scope,
context, the analyses, and compose. Workspace files survive a failed run, so
the agents can replace incomplete outputs.

For the complete `task/plan → owner approval → render → generated-source review
→ run` protocol, use the installed `locus-task-workflow` skill. Every command
uses the same `.locus-pi/plans/<run-name>` workspace.

## `task/implement-plan-template`

`task/implement-plan-template` is a renderer, not an executor. It needs only the
approved planning workspace. One scripting agent reads `plan.md` and every
`step-<n>.md` in numeric order, removes stale generated targets, and fully
replaces `implement-plan.workflow.mjs` from the shipped fixed prompt template.
Missing or malformed planning files leave the generated target absent, so
publication fails closed.

The renderer never invokes `task/plan`, never changes project source, and never
runs the file it writes. The generated file resolves only by explicit path.
Rendering is not approval to execute trusted JavaScript.

## `task/substep`

`task/substep` executes exactly one approved step. Its semantic input is a step
id such as `S1`, a file name such as `step-1.md`, or a bare number. One
implementation agent resolves that file, reinspects the live project, changes
only the selected scope, runs its checks, and fully replaces
`history/S<n>.md` with `Status: completed` or `Status: blocked`.

The generated `implement-plan.workflow.mjs` uses the same one-step contract in
literal prompts but does not invoke `task/substep`. This keeps the whole graph
visible and source-reviewable. `task/substep` remains the named manual entry for
one isolated step.

`task/substep` is intentionally different from the separate `implement`
workflow. `task/substep` executes one approved planning step; `implement`
applies selected findings from a post-code review.

## Boundaries

- Planning agents are instructed not to modify project files and not to run any
  step; the run never waits for an operator answer and fails closed instead.
- Calls use Pi's default workflow agent and its configured model route; the
  workflow source names no provider, model, model role, or specialized agent.
- A missing task, plan, step selector, or valid step catalog is handed to the
  agents as an explicit blocking input gap; they must not invent work.
- The catalog is frozen by planning and changed only deliberately: a new
  `task/plan` run replaces it, and owner edits to `step-<n>.md` are the owner's
  explicit act. The workflows add no freshness or integrity checks on top.
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
