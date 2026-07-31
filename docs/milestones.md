---
schema: locus.milestones.v2
title: "Milestones"
active_limit: 1
updated_at: "2026-07-22"
---

# Milestones

Registry for the `milestone:` frontmatter field on tasks and temporal decision
docs. Ids are `m<NN>-<slug>`, ordered by NN. Frontmatter `active_limit` bounds
the active set (`1` when absent for compatibility). Raising it is an explicit
owner decision. Its criterion is the quotable "done when" that gates closing it.
Closing a milestone marks it `done` in place; a separate archive step later moves
the closed row to `docs/milestones-archive.md` with its evidence. Evergreen
system-design docs carry no milestone.

| ID                                | Status | Period                  | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Note                                                                                                                                                                                                                                                             |
| --------------------------------- | ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1-workflow-dsl-convergence       | done   | 2026-07-21 - 2026-07-22 | `llm()` is absent from the DSL, its docs, its manifest and the curated portfolio ADR; `agent({schema})` returns a validated object and a non-conforming child answer fails closed under test; `--resume` replays recorded `agent()` results in a real curated run instead of re-spawning; a bounded agent catalog reaches the caller; `meta.phases[]` is read without executing the module; a workflow accepts structured input; `npm run check` green                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Met. Commit `6c9bbcc`; live source run `20260721-233305-b94e` and resume run `20260721-234810-9de7` prove six fresh calls became six replayed calls with no child sessions or usage; all four diagram renders regenerated; `npm run check` 69 files / 880 tests. |
| m2-inspectable-workflow-lifecycle | active | 2026-07-22 -            | Every agent answer plus every fresh child transcript/result envelope is indexed below `.pi/locus-pi/workflows/<runId>/artifacts`; a later run can consume only complete digest-bound refs through host continuation; the supported Pi viewer exposes run → stage → answer/transcript/result/log; `review` uses an agent clarifier and persisted two-artifact continuation without losing exact intent; `review-fix` consumes one immutable review artifact, uses an agent-selected validated dependency DAG and one writer per finding, collects independent check evidence, and performs a fresh dependency-aware re-review; ignored project-local planning and testing workflows prove split-run planning and independent testcase design/implementation/attribution without entering the tracked/public package; weak/strong dashboard runs yield an evidence-backed comparison; `npm run check` is green | T-118 established the inspectable artifact/runtime baseline; T-120 supersedes object-valued workflow input with semantic text plus closed host continuation. No curated registry or npm allowlist expansion; HTML export is optional.                            |

## m1-workflow-dsl-convergence

One model-calling primitive, one shaped-answer path, and a replayable run —
the convergence decided after comparing our workflow surface with Claude Code's.
The box exists to make the authoring surface cheaper to use, which the project
calls its unproven half; it deliberately adds no curated workflow.

| Task                                                                    | Role                                                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| T-110 — Add opt-in agent({schema}) structured output                    | The replacement path for shaped answers. Blocks T-108: deleting `llm()` first would leave no deterministic structured-output path. |
| T-108 — Remove the llm() primitive from the workflow DSL                | Collapses two model-calling surfaces into one. Also retires `llm-smoke` and amends the curated-portfolio ADR.                      |
| T-109 — Make workflow --resume a real replay of recorded agent calls    | Removes the rerun tax that makes iterative decomposition expensive; recorded clock/random values instead of banning `Date.now`.    |
| T-111 — Inject a bounded agent catalog into the caller context          | Turns agent selection from a guess into a choice; the caller currently never sees the catalog.                                     |
| T-114 — Accept structured workflow input alongside free text            | Historical implementation evidence. T-120 supersedes this public surface: current workflow semantic input is string-only.          |
| T-113 — Adopt static meta.phases[] in workflow metadata                 | Makes a run's shape readable before the run, via the existing no-execution AST scan.                                               |
| T-112 — Narrow the .claude/workflows interop claim                      | Removes a public claim that resolves for no real foreign workflow.                                                                 |
| T-115 — Prove --resume replay on a live Pi host with a curated workflow | The one criterion clause source-level work cannot close; replay's failure mode is a green run built on reused evidence.            |
| T-116 — Regenerate curated workflow diagram renders after llm() removal | Regenerated repo-only diagram sources and previews so no render advertises the removed `Direct LLM` primitive. Not packed.         |

All implementation tasks and both final evidence tasks are done and archived.

### Amendment 2026-07-22 — T-120 supersedes object-valued workflow input

The M1 row remains a factual record of what commit `6c9bbcc` proved. It is not
the current invocation contract. T-120 removes the unshipped generic object
payload without an adapter: workflow `input` is now only optional bounded human
text. Cross-run state uses a separate closed host `continuation` with exact
artifact refs; agents interpret meaning, while scripts orchestrate and validate
explicit decisions.
The live-host proof distinguishes a replayed green run from fresh work, and the
repo-only diagrams no longer advertise the removed primitive.

## m2-inspectable-workflow-lifecycle

One run owns its evidence; another run may consume it only through explicit
lineage. The product reader can move from a workflow summary into the exact
stage answer, transcript, or log that supports it. Review, remediation,
planning, and testing exercise the same contract without widening the curated
Package registry. The planning/testing examples remain ignored project-local
files, not tracked public package content.

| Task                                                   | Role                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-118 — Build inspectable split-run workflow lifecycle | Runtime artifact ownership, cross-run lineage, run viewer, review/remediation refinement, planning/testing examples, and weak/strong benchmark proof. |
