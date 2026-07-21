---
schema: locus.milestones.v2
title: "Milestones"
active_limit: 1
updated_at: "2026-07-21"
---

# Milestones

Registry for the `milestone:` frontmatter field on tasks and temporal decision
docs. Ids are `m<NN>-<slug>`, ordered by NN. Frontmatter `active_limit` bounds
the active set (`1` when absent for compatibility). Raising it is an explicit
owner decision. Its criterion is the quotable "done when" that gates closing it.
Closing a milestone marks it `done` in place; a separate archive step later moves
the closed row to `docs/milestones-archive.md` with its evidence. Evergreen
system-design docs carry no milestone.

| ID                          | Status | Period       | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                              | Note                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1-workflow-dsl-convergence | active | 2026-07-21 - | `llm()` is absent from the DSL, its docs, its manifest and the curated portfolio ADR; `agent({schema})` returns a validated object and a non-conforming child answer fails closed under test; `--resume` replays recorded `agent()` results in a real curated run instead of re-spawning; a bounded agent catalog reaches the caller; `meta.phases[]` is read without executing the module; a workflow accepts structured input; `npm run check` green | Six of seven clauses met on evidence (commit `6c9bbcc`, `npm run check` 69 files / 880 tests). Open: replay is proven only against a scripted child-agent executor, so "in a real curated run" is unmet until T-115 runs on a live Pi host. Owner decisions of 2026-07-21 in `.locus/research/workflow-surface-vs-claude-code/README.md` |

## m1-workflow-dsl-convergence

One model-calling primitive, one shaped-answer path, and a replayable run —
the convergence decided after comparing our workflow surface with Claude Code's.
The box exists to make the authoring surface cheaper to use, which the project
calls its unproven half; it deliberately adds no curated workflow.

| Task                                                                    | Role                                                                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| T-110 — Add opt-in agent({schema}) structured output                    | The replacement path for shaped answers. Blocks T-108: deleting `llm()` first would leave no deterministic structured-output path.           |
| T-108 — Remove the llm() primitive from the workflow DSL                | Collapses two model-calling surfaces into one. Also retires `llm-smoke` and amends the curated-portfolio ADR.                                |
| T-109 — Make workflow --resume a real replay of recorded agent calls    | Removes the rerun tax that makes iterative decomposition expensive; recorded clock/random values instead of banning `Date.now`.              |
| T-111 — Inject a bounded agent catalog into the caller context          | Turns agent selection from a guess into a choice; the caller currently never sees the catalog.                                               |
| T-114 — Accept structured workflow input alongside free text            | Stops every parameterised workflow from re-parsing its own parameters out of prose.                                                          |
| T-113 — Adopt static meta.phases[] in workflow metadata                 | Makes a run's shape readable before the run, via the existing no-execution AST scan.                                                         |
| T-112 — Narrow the .claude/workflows interop claim                      | Removes a public claim that resolves for no real foreign workflow.                                                                           |
| T-115 — Prove --resume replay on a live Pi host with a curated workflow | The one criterion clause source-level work cannot close; replay's failure mode is a green run built on reused evidence.                      |
| T-116 — Regenerate curated workflow diagram renders after llm() removal | The generators are clean; the rendered assets still show a `Direct LLM` legend for a primitive that no longer exists. Repo-only, not packed. |

All seven implementation tasks are done and archived. The box stays `active`
because its criterion is not yet fully met: T-115 (live-host replay proof) is
the remaining gate, and T-116 closes the last stale render of the removed
primitive.

Owner action outside any task: `.locus/soul.md` still says "five curated Package
workflows" in five places, and the portfolio is now four. That file is
owner-owned; no agent edited it.
