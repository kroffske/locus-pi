# Plan to sequential workflow

Use when an owner has approved a readable `plan.md` and its canonical
`steps.md` catalog, and wants an optional project-local workflow to execute that
frozen catalog as one visible sequential graph. Avoid this card when the Plan is
still changing, approval is missing, or the ordinary main-agent todo path is
more recoverable.

Avoid it too when the plain `implement each step in order, then summarize` graph
is all that is wanted: the Package `plan` workflow already renders exactly that
into `execute.workflow.mjs` in its workflow workspace from a fixed template, with
no Design or Build turn. Use this card for what the template deliberately omits —
a reviewer between steps, a bounded revision loop, concurrency, or a different
publication.

Design input: the approved Plan plus every complete canonical `## S<n>` block
from `steps.md`. Design proposes the graph only. Ordinary Design -> explicit
owner approval -> Build remains mandatory; approving the Plan does not approve
workflow source.

Graph: `task-1 implement -> optional task-1 review -> task-2 implement ->
optional task-2 review -> ... -> publish`. Each implementer receives exactly one
complete task block. A reviewer, when requested, is a visibly separate child
after that implementer and before the next task.

Cost: `N` attempts for `N` tasks without review, or `2N` baseline attempts with
one reviewer per task. Transport retries, value repairs, or an explicitly
approved revision loop add physical attempts and consume the shared
`totalAgents` budget. Execution is also constrained by the 24-hour
new-child-start gate, per-attempt fuses, context, and concurrency even though
this graph is sequential.

Handoff: prefer rendering the owner-approved complete task blocks as literal
author-known prompts in generated `.pi/workflows/<name>.workflow.mjs` source.
Programmatic embedders may instead pass the same frozen blocks as caller
`items`; that transport has no Locus items count or character policy. Neither
lane escapes total attempts, time, context, JSON, or Node-memory limits, and
workflow JavaScript never reparses `steps.md` or semantic task prose at runtime.

Failure: any implementer or blocking reviewer failure stops the run before the
next task. Review is advisory or blocking only as the approved Design states.
Automatic revision requires its own finite approved loop; review never implies
retry. File changes and task-history evidence must be idempotent because a
failed run can be retried.

Restart: each task prompt checks its matching `history/S<n>.md`, skips only
credible completed work, performs only that task, and deterministically writes
or replaces its own history record. The same frozen task text and stable task id
must be reused on retry.

Primitives: literal author-known arrays or `items()`, a visible bounded `for`
loop or `pipeline()`, direct `agent()` calls, optional `choice`, `phase()`,
`log()`, and one publication primitive. Do not add a Package example, runtime
catalog parser, paging primitive, warning-only fanout, or hidden manager agent.
