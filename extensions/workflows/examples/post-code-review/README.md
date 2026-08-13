# Post-code review workflow tree

`post-code-review` is one installable code-review workflow composed from seven
saved child workflows. The parent makes no model call itself: it owns order,
parallelism, the shared output directory, child identity, and final publication.

> **External entry point:**
> [`post-code-review.workflow.mjs`](./post-code-review.workflow.mjs). The other
> seven workflow files are source-bound child components coordinated by this
> parent.

The review uses several complementary perspectives rather than one repeated
style:

1. `post-code-review/scope` resolves the requested function, file, commit,
   commit range, diff, or locally available PR range into an exact evidence
   boundary.
2. `post-code-review/boundaries`, `post-code-review/simplicity`,
   `post-code-review/contracts`, and `post-code-review/style` run behind one
   parallel barrier. Each reopens `review-scope.md`, inspects live evidence
   independently, and writes only its own report. The style lane also reads the
   request-local `style.md` criteria.
3. `post-code-review/necessity` runs sequentially after the barrier, reopens the
   scope and all four lane reports, and challenges every proposed fix for a
   proven failure, a clear guarantee owner, duplicated responsibility, and net
   simplicity. It writes `review-necessity.md`.
4. `post-code-review/synthesis` reopens all six reports, independently verifies
   admitted claims against live source and consumers, removes unsupported or
   duplicate findings, assigns the final action levels, and writes
   `post-code-review.md`.
5. The parent publishes that final Markdown file as the run result.

The diagram below shows these workflow boundaries, exact source filenames,
model roles, Markdown handoffs, and the failure boundary on one canvas.

![Post-code review workflow graph](./post-code-review-pipeline.svg)

## Install

The tree is part of the `@kroffske/locus-pi` package boundary. From this
checkout, register the local package once; do not copy files out of task
artifacts or into every project:

```bash
cd /path/to/locus-pi
pi install .
```

After the release containing this tree is published, install it from npm:

```bash
pi install npm:@kroffske/locus-pi
```

After installation, start Pi in the project to review and confirm the Package
entries:

```text
/workflows list post-code-review
```

Run the external parent with a new explicit project-relative output namespace:

```text
/workflows run post-code-review --output-dir tmp/post-code-review/review-20260813-a review the current diff
```

The final path component is the review request id. Before launch, an operator
may create `tmp/post-code-review/<review-id>/style.md` with additional comment
and style criteria. The runtime preserves an existing regular file byte-for-byte
or creates it empty before the first agent runs. Empty means no extra criteria;
the style lane still applies live project conventions. A symlink or non-regular
`style.md` fails closed.

The same entry is available through the programmatic `workflow` tool and the
headless Pi command surface. A fresh review must use a new output directory;
resume reuses the exact source run and workspace.

## Decision and remediation contract

The final report answers whether source changes are needed:

- `READY` — no code change is warranted;
- `READY_WITH_RECOMMENDATIONS` — optional improvements exist, but they do not
  block acceptance;
- `CHANGES_REQUIRED` — at least one proven current defect blocks acceptance;
- `BLOCKED` — live evidence is insufficient for a trustworthy decision.

Each item independently carries `Action: REQUIRED`, `RECOMMENDED`, or
`NO_ACTION`, plus `Impact: high`, `medium`, or `low`. This keeps mandatory work
separate from impact. Rejected proposals and accepted responsibility boundaries
remain visible as `NO_ACTION` rather than disappearing.

For a REQUIRED or RECOMMENDED item, synthesis may include one small illustrative
fix snippet when it can do so truthfully. The snippet explains intended shape;
it is not a literal patch and never replaces ownership evidence, a complete
action, or verification. `NO_ACTION` items receive no fix snippet.

Apply the default REQUIRED set with the separate Package workflow `implement`:

```text
/workflows run implement --output-dir tmp/post-code-review/<review-id> apply REQUIRED fixes from post-code-review.md
```

Reuse the review workspace so the workflow can read the exact report. To include
optional work, explicitly say `apply REQUIRED and RECOMMENDED fixes`. A `READY`
report or an unselected recommendation produces an intentional `NO_WORK` result.
`post-code-review` itself remains read-only and never starts implementation.

## Source binding

All eight files are Package workflow entries because the Package registry scans
one directory level below `extensions/workflows/examples/`. The parent is the
intended external entry. Its seven `invokeWorkflow({ child })` edges bind
children to these installed Package files. A project or personal workflow with
the same name therefore cannot silently replace one child; a shadow causes the
run to fail before the child executes.

The children remain individually inspectable through `/workflows info`. Running
a lane directly is normally not useful because the boundaries, simplicity,
contracts, and synthesis lanes expect the parent's shared `review-scope.md`
handoff.

## Files in this directory

- `post-code-review.workflow.mjs` — external parent and final publisher.
- `scope.workflow.mjs` — exact scope and Git-semantics mapper.
- `boundaries.workflow.mjs` — ownership and architecture lane.
- `simplicity.workflow.mjs` — delete-first complexity lane.
- `contracts.workflow.mjs` — API, consumer, documentation, and
  validation-contract lane.
- `style.workflow.mjs` — comment quality and evidence-backed
  project-style lane with optional request-local criteria.
- `necessity.workflow.mjs` — sequential challenge to proposed
  fixes, their ownership, duplicated responsibility, and net complexity.
- `synthesis.workflow.mjs` — independent verifier and final
  report author.
- `post-code-review-pipeline.svg` — self-contained reader-facing interaction
  diagram.

The task-local `verify-post-code-review-bundle.mjs` and
`verify-post-code-review-scope-matrix.mjs` files are development checks, not
workflow entries and not installation artifacts. They validate the shipped
source graph and Git targeting rules during repository verification; operators
never run them to perform a code review.
