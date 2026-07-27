# Shipped workflow examples

This directory is the only place where a reader can see the authoring shape that
[`AUTHORING.md`](../AUTHORING.md) and [`references/patterns.md`](../references/patterns.md)
teach, applied to code that actually runs. This file says what ships, what each
example is for, which shape it demonstrates, and how far it travels.

Measured 2026-07-27 against the files in this directory.

## What ships

Counts are of real occurrences — `promptFile()` calls, `agent({ schema })` calls,
and `throw` statements — not of the words where a comment happens to mention one.

| Example                                                                                                          | Lines | `promptFile()` | Shaped calls | `throw` | Distribution                              |
| ---------------------------------------------------------------------------------------------------------------- | ----: | -------------: | -----------: | ------: | ----------------------------------------- |
| [`live-smoke.workflow.mjs`](./live-smoke.workflow.mjs)                                                           |    51 |              0 |            0 |       0 | curated · npm package · public repository |
| [`requirements-grill.workflow.mjs`](./requirements-grill.workflow.mjs)                                           |   309 |              0 |            0 |       0 | curated · npm package · public repository |
| [`review/review.workflow.mjs`](./review/review.workflow.mjs)                                                     |   876 |              2 |            2 |       5 | curated · npm package · public repository |
| [`review-fix/review-fix.workflow.mjs`](./review-fix/review-fix.workflow.mjs)                                     |   696 |              0 |            1 |      10 | curated · npm package · public repository |
| [`plan/plan.workflow.mjs`](./plan/plan.workflow.mjs)                                                             |   754 |              0 |            2 |       4 | curated · npm package · public repository |
| [`plan-implement/plan-implement.workflow.mjs`](./plan-implement/plan-implement.workflow.mjs)                     |   648 |              0 |            1 |       8 | curated · npm package · public repository |
| [`excalidraw-pipeline/excalidraw-pipeline.workflow.mjs`](./excalidraw-pipeline/excalidraw-pipeline.workflow.mjs) |   673 |              3 |            0 |       1 | tracked only                              |

Three distribution levels, and they are independent:

- **Curated** means the name resolves through `/workflow-run <name>`. The
  registry is the explicit allowlist `CURATED_PACKAGE_WORKFLOW_NAMES` in
  [`extensions/_shared/workflow-runner.ts`](../../_shared/workflow-runner.ts) —
  exactly `live-smoke`, `plan`, `plan-implement`, `requirements-grill`, `review`,
  `review-fix`. **Living in this directory registers nothing**, which is why
  `excalidraw-pipeline` sits beside them and does not resolve by name.
- **npm package** means the exact file is listed in `package.json#files`.
- **Public repository** means the exact file is listed in `public-repository.json`.
  Both lists name regular files, never directories, so a new file under an
  already-public folder is not published implicitly.

`excalidraw-pipeline` is tracked in Git and absent from all three. It is a
worked reference for a long fan-out pipeline with a per-stage model pin; read it,
copy from it, do not expect to run it by name.

The registry is also the only route to "tracked **and** resolvable by name":
every directory the resolver scans — `.pi/workflows/`, `.claude/workflows/`,
`.agents/workflows/` — is git-ignored in this repository, so a copy placed there
works on one machine and exists in no clone.

Adding a curated workflow is not a file drop: registry, tests, package
allowlist, manuals, support boundary, and changelog change together. See
[`docs/adr/curated-workflow-portfolio.md`](../../../docs/adr/curated-workflow-portfolio.md).

## What each example is for

| Example               | Product role                | Read it for                                                                                                                                                                          |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-smoke`          | Child-session diagnostic    | The smallest complete workflow: two sequential read-only `agent()` calls, one input check, no schemas.                                                                               |
| `requirements-grill`  | Requirements refinement     | Workflow-owned repository search (a bounded `rg` the script runs itself, not an agent), and fail-closed exits at every stage.                                                        |
| `review`              | Evidence-backed code review | The staged text pipeline, two shaped `agent({ schema })` gates, a split-run operator handoff, a bounded assessed loop, **and** both halves of the prompt-placement rule in one file. |
| `review-fix`          | Human-directed fixes        | A model-planned dependency graph that deterministic code validates and orders before any writer starts, one writer per finding, host-owned source fingerprints.                      |
| `plan`                | Task → accepted plan        | Two loops with different owners: one operator clarification round that can pause the run, and a bounded draft/critique loop whose exit is a shaped verdict.                          |
| `plan-implement`      | Accepted plan → changes     | The other end of a cross-run handoff: host-verified plan bytes, deterministic step parsing, one writer per step, and a deliberate `partial: true` outcome.                           |
| `excalidraw-pipeline` | Reference only              | Fan-out over many sections with per-section repair, and an explicit per-stage `model:` pin.                                                                                          |

`plan` and `plan-implement` are a pair, and the seam between them is the point:
`plan` ends by returning the accepted plan text, which the runtime retains as
`plan.md`; `plan-implement` takes that artifact's complete
`{ runId, artifactId, name, sha256 }` reference through the workflow tool's
closed `continuation` control and refuses anything else — including a same-named
draft from an earlier round of the same run, because it checks that these bytes
were the run's terminal result. `review` → `review-fix` is the curated version of
the same seam.

## Which authoring shape each one demonstrates

**Prompts.** Stage prompts are written inline in the script by default. A
neighboring `resources/<stage>.prompt.md` rendered through `promptFile()` is the
escape hatch for a role charter long enough to bury the routing — roughly 80
lines and up — or a prompt shared by more than one workflow.

| Example               | Prompt placement                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`          | Inline; the prompts are one line each.                                                                                                                                                                                              |
| `requirements-grill`  | Inline.                                                                                                                                                                                                                             |
| `review`              | Inline `COMMON` contract plus five stage tasks; `resources/interrogator.prompt.md` (136 lines) and `resources/verifier.prompt.md` (139 lines) stay external. This is the example to read when you need to see _both_ rules at once. |
| `review-fix`          | Inline `COMMON` plus every stage task. No `resources/` directory.                                                                                                                                                                   |
| `plan`                | Inline `COMMON` plus every stage task, including both loop bodies. No `resources/` directory.                                                                                                                                       |
| `plan-implement`      | Inline `COMMON` plus every stage task. No `resources/` directory.                                                                                                                                                                   |
| `excalidraw-pipeline` | Three external prompt files, unmigrated.                                                                                                                                                                                            |

A prompt rendered inside a loop is still one prompt file: `promptFile()` snapshots
and hashes a resource once per run, so `review` re-renders its interrogator
charter for every round and still records exactly two pieces of prompt evidence.

The four short `review` prompts and all five `review-fix` prompts moved inline on
2026-07-26 under the amendment recorded in
[`docs/adr/text-agent-results-and-prompt-resources.md`](../../../docs/adr/text-agent-results-and-prompt-resources.md).

**Shape versus meaning, in three tiers.** Lengths, counts, id patterns, enums,
uniqueness and blankness belong in `agent({ schema })`. Cross-field agreement,
referential integrity, budgets summed across items and graph shape belong in
`validate` on the same call — script code that the runtime re-asks rather than
script code that ends the run. Only two classes stay fatal throws: self-reported
status, a model's verdict graded against its own findings, and evidence this
child did not produce (host-owned provenance, prior-run text).

That is why `review` now carries 5 fatal throws and `review-fix` 10, down from 14
and 18 on 2026-07-26, without a single check being dropped.

| Example                            | Declared in the schema                                                                                                                                                                                                                                                                         | Passed as `validate`                                                                                                                                   | Still a fatal throw                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `review`                           | `CLARIFIER_SCHEMA`: question id pattern, ≤8 questions, ≤8 options, 500-character prompts, 200-character options, unique ids, unique trimmed options, non-blank strings; `QUESTION_COVERAGE_SCHEMA`: `complete`/`more_questions_needed`, ≤8 gaps, 400-character gaps, unique trimmed, non-blank | `clarifierDecisionErrors` and `questionCoverageErrors`: the decision must agree with its list; `recommended` must name a real option; combined budgets | Continuation identity, prepare-artifact provenance, operator-input bounds |
| `review-fix`                       | `FINDING_SELECTOR_SCHEMA`: `^F[1-9][0-9]*$` ids, 1–20 findings, 8,000-character notes, unique ids, unique dependencies                                                                                                                                                                         | `findingPlanErrors`: every id exists in the immutable review; no self-edge; dependencies must themselves be selected; acyclic; combined note budget    | `reviewRef` provenance, parsing the prior run's review, input bounds      |
| `plan`                             | `CLARIFIER_SCHEMA` as above at ≤6 questions; `PLAN_VERDICT_SCHEMA`: `accept`/`revise`, ≤12 defects, 600-character defects, unique trimmed, non-blank                                                                                                                                           | `clarifierDecisionErrors`, `planVerdictErrors`: `accept` with defects and `revise` without them are both unusable; combined budgets                    | Continuation identity and provenance, operator-input bounds               |
| `plan-implement`                   | `STEP_SELECTOR_SCHEMA`: `^S[1-9][0-9]*$` ids, 1–30 steps, 4,000-character notes, unique ids                                                                                                                                                                                                    | `stepSelectionErrors`: every id exists in the accepted plan; combined note budget                                                                      | `planRef` provenance, parsing the prior run's plan, input bounds          |
| `live-smoke`, `requirements-grill` | — (no shaped stage)                                                                                                                                                                                                                                                                            | —                                                                                                                                                      | Input bounds only                                                         |

**Loops need a declared exit, not a scan.** Two shipped loops — `review`'s
interrogation rounds and `plan`'s drafting rounds — decide "again or done?" the
same way: the round's own reader returns a shaped verdict with the concrete gaps
or defects that justify another round, script code branches on the enum, and the
free text is handed to the next round verbatim. Neither greps the previous
round's Markdown, and both record which condition stopped them — the measured
verdict or the safety cap. `plan`'s clarification round is a different animal and
is not one of them: it runs at most once, and what ends it is the operator
answering, not a judge.

**Free-text bounds.** An agent's own answer is bounded by that call's
`maxAnswerChars`, so an oversized handoff names the call that produced it.
Operator input, consumed artifacts, and workflow-composed handoffs are bounded by
script code, because no call produced them.

**Never parse model prose.** No shipped example runs a regex over
model-authored text to make a decision. When a decision depends on a fact, the
model declares that fact as a schema field and a fresh reader checks the
declaration. The one regex that remains in `review` — `declaredNoChanges()` — is
a cheap early exit that saves three model calls, not a gate, and it is documented
as such at its definition.

## Diagrams

Every curated example ships a `<name>-pipeline.diagram.mjs` generator, an
editable `<name>-pipeline.excalidraw`, and a rendered `<name>-pipeline.png`. The
generator is the source of truth: edit it and regenerate, never hand-edit the
`.excalidraw`. The generators require `@kroffske/excalidraw-diagrams`, which is
not a dependency of this package.

All four pipelines are authored as one long left-to-right strip and then wrapped
into two stacked bands by a `bandX`/`bandY` transform at the top of each
generator, because an unwrapped strip renders as a 3:1–4:1 sliver whose text is
unreadable at fit-to-window. Authored coordinates never change; only the
transform moves them.

`extensions/workflows/examples/excalidraw-pipeline` ships no diagram triple —
the contract applies to curated workflows.
