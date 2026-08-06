# plan

`plan` is the planning half of the shipped task workflow. It accepts one task,
uses one agent to map the live repository, then uses one planning agent to write
the plan and its dynamic implementation queue.

The workflow is intentionally small:

```text
task
  → reconnaissance agent
      → context.md
  → planning agent
      → plan.md
      → steps.md
```

There is no critic, review loop, Markdown parser, todo manager, or model pin in
the script. The agents inspect and write; JavaScript only orders the two calls
and passes the reconnaissance text to the planner.

## Workspace files

Every child receives the same project-local workflow workspace. It defaults to
`<pwd>/tmp/plan/`; a caller using the `workflow` tool can select a shared
directory such as `tmp/cron-to-dag`.

- `context.md` — repository facts, relevant files, constraints, and unknowns.
- `plan.md` — coherent top-level work units followed by outcome, approach,
  dependencies, exclusions, and verification.
- `steps.md` — the only executable task catalog. Each complete flat
  `## S<n> — ...` block is enough context for one fresh implementation agent.

The planner fully replaces `plan.md` and `steps.md` on every successful run. A
selected workspace name is not a run id or audit id; callers may reuse it when
they intend to replace the plan.

## Decomposition contract

`plan.md` defines top-level work units before `steps.md` decomposes them. One
work unit owns a migration domain or responsibility boundary. Planning may use
fresh-agent analysis to understand those units, but the planning owner
reconciles the result into one owner-readable plan and freezes the final task
catalog before execution.

Every executable task is one flat block with exactly one structural heading:
`## S<n> — <short title>`. It has no nested structural headings. Labeled prose
or bullets inside the block carry its work-unit identity, decomposition
boundary, exact goal, paths and evidence, dependencies, allowed ownership,
verification, and done condition. `steps.md` stays the only executable catalog;
there is no `tasks.md`.

Choose the boundary that preserves one coherent, independently verifiable
outcome:

- **File boundary** — isolated ownership of one file.
- **Function boundary** — one behavior and its local callers.
- **Behavior boundary** — one observable contract crossing files.
- **Side-effect boundary** — database, API, email, file, or subprocess work.
- **Ownership boundary** — configuration, common, or platform modules.

Do not enumerate every tiny operation in one handoff. Do not combine unrelated
work merely to reduce task count. If analysis changes the catalog, rerun `plan`
and deliberately replace the queue before execution; never mutate active exact
blocks implicitly.

## Execution choices

Default execution remains main Pi todo state plus one top-level
`plan-implement` run per frozen exact block. The installed
`locus-task-workflow` skill owns that orchestration; neither Package workflow
parses the catalog or dispatches another workflow.

After an operator approves `plan.md` and `steps.md`, an optional next action is
to hand both artifacts to `workflow-author` Design for a sequential
project-local workflow. Plan does not generate or build workflow source, and
Design approval remains separate from Build approval. Any optional reviewer
after a generated step belongs to that Design, not to Plan or Plan Implement
execution semantics.

## Run and resume

Direct command use keeps the default workspace:

```text
/workflows run plan Move the cron job into a DAG
/workflows run plan --resume <runId> Move the cron job into a DAG
```

Resume requires unchanged workflow source and input. The runtime replays the
completed reconnaissance answer and reruns the first unfinished call. Workspace
files survive a failed run, so the planner can replace incomplete outputs.

For the complete `plan → session todos → one step per run` protocol, use the
installed `locus-task-workflow` skill. It calls both Package workflows with the
same explicit `tmp/<select-name>` workspace.

## Boundaries

- Planning agents are instructed not to modify project files.
- Calls use Pi's default workflow agent and its configured model route; the
  workflow source names no provider, model, model role, or specialized agent.
- A missing task is handed to the agents as an explicit blocking input gap;
  they must not invent implementation work.
- The final catalog is frozen before execution; catalog changes require a new
  Plan run and deliberate queue rebuild.
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
