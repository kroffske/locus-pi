# task workflows

`task` is a group-only Package namespace. It is not runnable by itself; use
`task/plan` to prepare a task, `task/implement` to execute one approved step,
and `task/script` to optionally render the sequential execute script from the
approved files. The shared prefix makes the relationship visible without
pretending that planning approval and implementation are one automatic run.

## `task/plan`

`task/plan` is the planning half of the shipped task workflow. It accepts one
task, uses one agent to map the live repository and one planning agent to write
the plan and its dynamic implementation queue — one file per step.

The workflow is intentionally small:

```text
task
  → reconnaissance agent
      → context.md
  → planning agent
      → plan.md
      → step-1.md … step-<n>.md
```

There is no critic, review loop, Markdown parser, todo manager, script
renderer, or model pin in the script. The agents inspect and write; JavaScript
only orders the two calls and passes the reconnaissance text to the planner.

**The run stops there.** `task/plan` implements nothing and starts nothing. It
writes files and returns a result that says so. Execution is a separate act the
owner takes after reading `plan.md` and the `step-<n>.md` files.

## Workspace files

Every child receives the same project-local workflow workspace. It defaults to
`<pwd>/tmp/plan/`; a caller using the `workflow` tool can select a shared
directory such as `tmp/cron-to-dag`.

- `context.md` — repository facts, relevant files, constraints, and unknowns.
- `plan.md` — coherent top-level work units followed by outcome, approach,
  dependencies, exclusions, and verification.
- `step-<n>.md` — the executable task catalog, one file per step in execution
  order. Each file is one complete flat `## S<n> — ...` block with enough
  context for one fresh implementation agent; the `S<n>` in the heading matches
  the `<n>` in the file name.
- `execute.workflow.mjs` — rendered later by `task/script`, only when the owner
  chooses that route.

The planner fully replaces `plan.md` and the `step-<n>.md` catalog on every
successful run, deleting leftover step files a new shorter catalog does not
replace. A selected workspace name is not a run id or audit id; callers may
reuse it when they intend to replace the plan.

**The files on disk are the contract.** After planning, the owner may edit
`plan.md` and any `step-<n>.md` before execution; `task/script` and
`task/implement` read whatever the files say at run time and add no freshness or
integrity checks. Deliberate owner edits are a feature; keeping the edited
catalog coherent is the owner's responsibility.

## `task/script` and the generated execute script

`task/script` is the optional rendering step. One scripting agent reads
`plan.md` and the frozen `step-<n>.md` catalog from the workspace and fully
replaces `execute.workflow.mjs`. `resources/execute-template.prompt.md` holds
both the agent's charter and the fixed source template it fills. The agent
substitutes only a description, each step id, each step title, and each verbatim
`## S<n>` block; it changes nothing else. The result is one
`phase()`/`log()`/`agent()` group per step file in catalog order, then a summary
agent that writes `result.md` from `plan.md` and `history/*.md`, then
`publishPrimaryFile("result.md")`.

Every step prompt is literal author-known text, so the generated script parses
no catalog at runtime. Each step prompt reads its own `history/S<n>.md` first
and returns the existing record unchanged when that step is already credibly
complete, which is what makes rerunning the script safe after a failed step.

Two boundaries hold the trust line:

- It is written to the workflow workspace, never to `.pi/workflows/`,
  `.claude/workflows/`, or `.agents/workflows/`. It is not a registered
  workflow and does not resolve by bare name — only
  `/workflows run <workspace>/execute.workflow.mjs` reaches it.
- Running it is the owner's explicit act. Workflow JavaScript runs in Pi's main
  Node.js process with full filesystem, subprocess, and network authority, so
  read the file before running it. Approving a plan is not approving a run, and
  rendering is not approval to run.

The template deliberately omits loops, reviewers, retries, parsers, schemas,
`try`/`catch`, and nested workflows. A graph that needs any of those uses the
bespoke continuous-authoring route described below.

## Decomposition contract

`plan.md` defines top-level work units before the `step-<n>.md` catalog
decomposes them. One work unit owns a migration domain or responsibility
boundary. Planning may use fresh-agent analysis to understand those units, but
the planning owner reconciles the result into one owner-readable plan and
freezes the final task catalog before execution.

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

The generated `execute.workflow.mjs` is the second route: the operator runs
`task/script` against the same workspace, reviews the rendered file, and runs
`/workflows run <workspace>/execute.workflow.mjs`. It runs the same frozen
step files as one sequential graph in a single run instead of one run per
step, which is fewer moving parts but a coarser recovery unit.

For a graph the fixed template does not express, send `workflow-author` a
normal authoring request: `Author a sequential project-local workflow from the
approved plan.md and step-<n>.md catalog in this workflow workspace.`
The author writes Design,
reviews it, and Builds matching source in the same turn. Do not inject
`Design only` or a second Build request;
only the user may separately request a pause after design. Plan writes only planning files into
the workflow workspace and never writes a registered project workflow. Any
optional reviewer after a generated step belongs to the bespoke design, not to
Task Plan, Task Script, or Task Implement execution semantics.

## Run and resume

Direct command use keeps the default workspace:

```text
/workflows run task/plan Move the cron job into a DAG
/workflows run task/plan --resume <runId> Move the cron job into a DAG
/workflows run task/script --output-dir tmp/cron-to-dag
/workflows run task/implement --output-dir tmp/cron-to-dag -- S1
```

Resume requires unchanged workflow source and input. The runtime replays every
completed answer and reruns the first unfinished call, so a `task/plan` run
that failed in planning replays reconnaissance. Workspace files survive a
failed run, so the agents can replace incomplete outputs.

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

- Planning and scripting agents are instructed not to modify project files, not
  to run any step, and not to execute the script they write.
- The scripting agent writes only inside the workflow workspace. It is told
  never to write to `.pi/workflows/`, `.claude/workflows/`, or
  `.agents/workflows/`.
- Calls use Pi's default workflow agent and its configured model route; the
  workflow source names no provider, model, model role, or specialized agent.
- A missing task or step selector is handed to the agents as an explicit
  blocking input gap; they must not invent implementation work.
- The catalog is frozen by planning and changed only deliberately: a new
  `task/plan` run replaces it, and owner edits to `step-<n>.md` are the owner's
  explicit act. The workflows add no freshness or integrity checks on top.
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
