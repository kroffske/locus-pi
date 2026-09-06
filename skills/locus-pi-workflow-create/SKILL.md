---
name: locus-pi-workflow-create
description: Create or revise an orchestration-only locus-pi `.workflow.mjs` agent graph through Design, review, Build, and source validation. Generated source contains prompts and agent/DSL edges, not file-reading logic. Never run the workflow.
---

# Create a locus-pi workflow

This skill owns authoring only. Do not use merely to run an existing workflow; use the `locus-pi-workflow-run` skill for launch, stopped-run recovery and monitoring. Build does not run. No package-provided catalog agent is required.

## Select the graph before loading details

Read [the pattern index](references/INDEX.md), then only the selected card. Default to a fixed graph; choose adaptation when the requirement needs evidence-gated additional work. Claude Code is not a control plane or a required dependency.

| Requirement                                                     | Read                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| Known stages and a fixed number of calls                        | [Fixed graph](references/fixed-graph.md)               |
| Incomplete output must go to a fresh worker with exact feedback | [Bounded refinement](references/bounded-refinement.md) |
| Independent work units are discovered at runtime                | [Bounded decomposition](references/decomposition.md)   |
| A decision or authorization is missing                          | [Human continuation](references/human-continuation.md) |

## Design → review → Build

A plain authoring request writes `.locus-pi/workflows/<name>/<name>.design.md`, reviews it, then builds exactly its `Entries` table. Read [design-and-build.md](references/design-and-build.md) before writing the design or source. A `runnable root` includes the root; `group-only` has only direct child entries. Stop after the design only for an explicit design-only request, pause after design or do not build.

Build-only requests remain `Build design: <exact path>` and `Build approved design: <exact path>`. A material algorithm mismatch returns to design review; never hide it in source.

## Source and evidence boundary

Workflow source is orchestration only: explicit prompts, visible DSL edges and whole-value handoffs. Agents own interpretation, any source inspection requested by their prompt, and complete reader-facing results. Read the canonical [AUTHORING.md](../../extensions/workflows/AUTHORING.md#machine-enforced-standard-source-shape) for the permitted grammar; do not infer permission from a legacy recipe.

Every callsite needs its own literal `label`. A dynamic `title` is display text, not identity. Same-session output clarification is not a semantic round; semantic continuation creates a fresh worker. Recovery is a separate runtime capability.

Run `workflow_check_source` with `mode: "orchestration-only"` on every exact built source, plus the design/source and module-load checks. An unavailable tool or failed checker result is a failed gate: never report a successful Build after skipping it. Return the exact copyable launch command `/workflows run <name>` without executing it unless execution was separately requested.

## Trust and further references

Reviewed JavaScript runs in the Pi host process; approval and worktrees are not a sandbox. Runtime/API authority is [REFERENCE.md](../../extensions/workflows/REFERENCE.md). Follow only the section needed by the selected graph. Do not load the entire runtime manual just to author a fixed chain.
