# Workflow Creator

`workflow-creator` is a shipped Package workflow that turns one semantic request
for a Locus Pi workflow into a reviewed, workspace-local package. It does not
install, register, commit, or run the workflow it creates.

> **External entry point:**
> [`workflow-creator.workflow.mjs`](./workflow-creator.workflow.mjs). The
> `design`, `svg`, and `build` entries are source-bound saved children coordinated
> by that parent.

## Graph

```text
workflow-creator
  -> workflow-creator/design
       author -> independent review -> accept
                                 \-> revise once -> fresh review -> accept or fail
       writes workflow.design.md
  -> workflow-creator/svg
       author -> independent review -> accept
                                 \-> revise once -> fresh review -> accept or fail
       reads workflow.design.md; writes workflow.svg
  -> workflow-creator/build
       builder -> independent review -> accept
                                  \-> correct once -> fresh review -> accept or fail
       reads Design and SVG; writes generated/<target>/*.workflow.mjs
       writes workflow-package.md
  -> publish workflow-package.md
```

The parent runs all three children sequentially in one shared workflow workspace.
Each child is a real saved run with its own evidence and durable key. A later
stage starts only after its predecessor succeeds.

## Workspace artifacts

The default workspace is a unique `.locus-pi/plans/<generated-run-name>/` directory. Use `--output-dir` to
select a different safe project-relative directory. Successful work leaves:

- `workflow.design.md` — accepted architecture, entries, graph, handoffs,
  bounds, failure exits, and live-source assumptions;
- `workflow.svg` — accepted self-contained SVG rendering of that graph;
- `generated/<target>/*.workflow.mjs` — exactly the source files declared by
  the accepted Design;
- `workflow-package.md` — reader-facing manifest and verification evidence.

Generated files remain workspace-only. The workflow must not write to tracked
project source, `.pi/workflows/`, User workflows, or this Package registry.
Promoting generated source into any registered catalog is a separate reviewed
owner action.

## Review and failure boundary

Every child permits at most one complete revision. The initial artifact receives
an independent review and a runtime-owned `accept|revise` decision. A revised
artifact receives a fresh independent review and must be accepted; a second
rejection fails the child. Missing predecessor files, unsafe writes, source
drift that invalidates evidence, checker/import/identity mismatch, or
Design/source/SVG divergence also fail closed. The parent publishes nothing
unless all three children succeed.

The Build child checks every generated `.workflow.mjs` with the live
`workflow_check_source` Pi tool, assesses source identity, imports each
module without calling its default export, checks exact metadata identities, and
compares the source graph with both accepted artifacts. Those checks prove
static consistency only.

## Launch

Choose a fresh request-specific workspace and describe the desired workflow as
semantic text:

```text
/workflows run workflow-creator -- <describe the workflow to create>
```

The three child entries remain directly inspectable through `/workflows info`,
but ordinary use starts the parent so they share accepted artifacts and saved-run
lineage.

## Trust boundary

Neither `workflow-creator` nor its Build child executes a generated workflow.
Static source checks are not runtime proof. Workflow JavaScript is trusted code
executed in Pi's main Node.js process with filesystem, subprocess, and network
authority. Read the generated files and make a separate explicit decision before
registering or running them.

## Files in this directory

- `workflow-creator.workflow.mjs` — sequential parent and final publisher.
- `design.workflow.mjs` — Design authoring plus bounded independent review.
- `svg.workflow.mjs` — SVG authoring plus bounded semantic and visual review.
- `build.workflow.mjs` — exact source build, verification, bounded correction,
  and package manifest.
