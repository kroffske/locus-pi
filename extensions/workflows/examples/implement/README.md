# implement

`implement` applies an already prepared plan or review without silently widening
it. The semantic input names the source file in the selected workflow workspace
and the requested action threshold.

```text
source plan or review
  → normalized implementation-plan.md
  → execute | no-work | needs-operator
  → implementation-work.md
  → independent implementation-review.md
  → accept | one correction | blocked
  → implementation-report.md
```

## Run it

For the output of `post-code-review`, reuse that review's explicit workspace:

```text
/workflows run implement --output-dir tmp/post-code-review/<review-id> apply REQUIRED fixes from post-code-review.md
```

`REQUIRED` is the default. Include `RECOMMENDED` only through an explicit request,
for example `apply REQUIRED and RECOMMENDED fixes from post-code-review.md`.
`NO_ACTION` items, rejected proposals, and illustrative snippets are never work
units. A snippet communicates intended shape; the implementation agent must adapt
it to the current code.

The run writes or replaces:

- `implementation-plan.md` — normalized source, selected action level, exact
  scope, steps, checks, and unresolved decisions;
- `implementation-work.md` — changed files and focused check evidence;
- `implementation-review.md` — independent inspection of the live result;
- `implementation-report.md` — terminal `COMPLETED`, `NO_WORK`, or `BLOCKED`
  outcome.

If no selected work exists, the workflow changes no project source and publishes
`Status: NO_WORK`. If an owner or product decision is missing, it publishes the
prepared plan and pauses for one operator answer. Implementation gets at most one
verifier-backed corrective pass; a remaining defect becomes `BLOCKED`.

## Boundaries

- The workflow reads live source and preserves unrelated dirty work.
- It does not parse Markdown in JavaScript; agents carry complete exact-text
  handoffs and runtime-owned choices select branches.
- It does not stage, commit, push, open a pull request, merge, deploy, mutate a
  remote, stash, or discard user changes.
- It does not replace `task/substep` or the generated
  `implement-plan.workflow.mjs`: those surfaces execute approved planning
  steps, while `implement` applies selected post-code-review findings.
