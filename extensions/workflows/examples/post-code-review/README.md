# Post-code review workflow bundle

`post-code-review` is one installable code-review workflow composed from six
saved child workflows. The parent makes no model call itself: it owns order,
parallelism, the shared output directory, child identity, and final publication.

> **External entry point:**
> [`post-code-review.workflow.mjs`](./post-code-review.workflow.mjs). The other
> six workflow files are source-bound child components coordinated by this
> parent.

The review uses several complementary perspectives rather than one repeated
style:

1. `post-code-review-scope` resolves the requested function, file, commit,
   commit range, diff, or locally available PR range into an exact evidence
   boundary.
2. `post-code-review-boundaries`, `post-code-review-simplicity`, and
   `post-code-review-contracts` run behind one parallel barrier. Each reopens
   `review-scope.md`, inspects live evidence independently, and writes only its
   own report.
3. `post-code-review-necessity` runs sequentially after the barrier, reopens the
   scope and all three lane reports, and challenges every proposed fix for a
   proven failure, a clear guarantee owner, duplicated responsibility, and net
   simplicity. It writes `review-necessity.md`.
4. `post-code-review-synthesis` reopens all five reports, independently verifies
   admitted claims against live source and consumers, removes unsupported or
   duplicate findings, and writes `post-code-review.md`.
5. The parent publishes that final Markdown file as the run result.

The diagram below shows these workflow boundaries, exact source filenames,
model roles, Markdown handoffs, and the failure boundary on one canvas.

![Post-code review workflow graph](./post-code-review-pipeline.svg)

## Install

The bundle is part of the `@kroffske/locus-pi` package boundary. From this
checkout, register the local package once; do not copy files out of task
artifacts or into every project:

```bash
cd /path/to/locus-pi
pi install .
```

After the release containing this bundle is published, install it from npm:

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

The same entry is available through the programmatic `workflow` tool and the
headless Pi command surface. A fresh review must use a new output directory;
resume reuses the exact source run and workspace.

## Source binding

All seven files are Package workflow entries because the Package registry scans
one directory level below `extensions/workflows/examples/`. The parent is the
intended external entry. Its six `invokeWorkflow({ packageName })` edges bind
children to these installed Package files. A project or personal workflow with
the same name therefore cannot silently replace one child; a shadow causes the
run to fail before the child executes.

The children remain individually inspectable through `/workflows info`. Running
a lane directly is normally not useful because the boundaries, simplicity,
contracts, and synthesis lanes expect the parent's shared `review-scope.md`
handoff.

## Files in this directory

- `post-code-review.workflow.mjs` — external parent and final publisher.
- `post-code-review-scope.workflow.mjs` — exact scope and Git-semantics mapper.
- `post-code-review-boundaries.workflow.mjs` — ownership and architecture lane.
- `post-code-review-simplicity.workflow.mjs` — delete-first complexity lane.
- `post-code-review-contracts.workflow.mjs` — API, consumer, documentation, and
  validation-contract lane.
- `post-code-review-necessity.workflow.mjs` — sequential challenge to proposed
  fixes, their ownership, duplicated responsibility, and net complexity.
- `post-code-review-synthesis.workflow.mjs` — independent verifier and final
  report author.
- `post-code-review-pipeline.svg` — self-contained reader-facing interaction
  diagram.

The task-local `verify-post-code-review-bundle.mjs` and
`verify-post-code-review-scope-matrix.mjs` files are development checks, not
workflow entries and not installation artifacts. They validate the shipped
source graph and Git targeting rules during repository verification; operators
never run them to perform a code review.
