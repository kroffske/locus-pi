# task workflows

`task` is a group-only Package namespace. It is not runnable by itself. Use
`task/draft` to translate a raw request, `task/plan` to prepare an accepted task,
and `task/implement` to execute the complete approved plan.
The shared prefix makes the relationship visible without pretending that
planning approval and implementation are one automatic run. The one-run
alternative lives beside the namespace as the separate root workflow
`task-via-script`, which runs this same planning pipeline as its own stage and
then renders a sequential implement script.

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
`task/draft`, `task/plan`, `task/implement`, or `task-via-script` run receives a unique default beneath
`.locus-pi/plans/`, for example
`.locus-pi/plans/20260819-142530-a1b2-task-draft/`. The prefix is the run id:
a sortable UTC timestamp plus a random suffix. The workflow slug keeps the
origin visible. That folder leaf is the generated run name. A caller may instead
select `.locus-pi/plans/<name>` with `--run-name <name>`.

The manual route reuses one directory deliberately. After `task/draft`, copy
the exact `task/plan --run-name ...` command from the completion card. Every
later `task/implement` completion uses that same run name.

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

The pipeline fully replaces its assigned files on every successful run,
deleting leftover step files a new shorter catalog does not replace. A selected
workspace may be reused when the owner intends to refine a draft, replace a
plan, or execute its approved steps. Independent work uses a fresh planning
directory.

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

Default execution is one top-level `task/implement` run on the approved planning
workspace. One implementation agent reads the full catalog from disk and
executes its steps in order. The installed `locus-task-workflow` skill owns the
review and launch boundary; neither Package workflow parses the catalog or
dispatches another workflow.

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
/workflows run task/draft -- Move the cron job into a DAG
/workflows run task/draft --run-name airflow-builder -- Move the cron job into a DAG
/workflows run task/plan --run-name airflow-builder
/workflows run task/implement --run-name airflow-builder
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

For the complete `task/plan → owner approval → task/implement` protocol, use the
installed `locus-task-workflow` skill. It calls both Package workflows with the
same `.locus-pi/plans/<run-name>` workspace.

## `task/implement`

`task/implement` executes the complete approved plan. It needs only the same
planning workspace used by `task/plan`; no step selector is accepted or needed.
One implementation agent reads `plan.md`, every `step-<n>.md` in numeric order,
and existing `history/*.md`. It treats the files on disk as the contract,
reinspects the live project before each step, changes only that step's allowed
scope, runs its checks, and fully replaces `history/S<n>.md` with
`Status: completed` or `Status: blocked`.

The workflow JavaScript does not parse or loop over steps. It has no todo
manager, reviewer, report renderer, nested workflow, or model pin. The one
implementation agent owns ordered execution inside a single top-level run.

If one step fails or reports blocked, earlier histories stay complete and later
steps do not start. A resumed or repeated run reads those histories as evidence,
rechecks the live state, and continues only when the ordered plan remains valid.
The workflow returns one concise summary after the final step or the first
blocker.

`task/implement` is intentionally different from the separate `implement`
workflow. `task/implement` executes an approved task plan; `implement` applies
selected findings from a post-code review.

## Boundaries

- Planning agents are instructed not to modify project files and not to run any
  step; the run never waits for an operator answer and fails closed instead.
- Calls use Pi's default workflow agent and its configured model route; the
  workflow source names no provider, model, model role, or specialized agent.
- A missing task, plan, or valid step catalog is handed to the agents as an
  explicit blocking input gap; they must not invent implementation work.
- The catalog is frozen by planning and changed only deliberately: a new
  `task/plan` run replaces it, and owner edits to `step-<n>.md` are the owner's
  explicit act. The workflows add no freshness or integrity checks on top.
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
