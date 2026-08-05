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
- `plan.md` — outcome, approach, dependencies, exclusions, and verification.
- `steps.md` — complete `## S<n> — ...` work units. Each block is enough context
  for one fresh implementation agent.

The planner fully replaces `plan.md` and `steps.md` on every successful run. A
selected workspace name is not a run id or audit id; callers may reuse it when
they intend to replace the plan.

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
- Workflow JavaScript is trusted code, not a sandbox. Runtime approval is
  consent to execute the shipped script, not design approval.
