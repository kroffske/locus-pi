# Shipped workflow examples

This directory is the only place where a reader can see the authoring shape that
[`AUTHORING.md`](../AUTHORING.md) and [`references/patterns.md`](../references/patterns.md)
teach, applied to code that actually runs. This file says what ships, what each
example is for, which shape it demonstrates, and how far it travels.

Measured 2026-07-26 against the files in this directory.

## What ships

| Example                                                                                                          | Lines | `promptFile(` | `schema:` | `throw` | Distribution                              |
| ---------------------------------------------------------------------------------------------------------------- | ----: | ------------: | --------: | ------: | ----------------------------------------- |
| [`live-smoke.workflow.mjs`](./live-smoke.workflow.mjs)                                                           |    51 |             0 |         0 |       0 | curated · npm package · public repository |
| [`requirements-grill.workflow.mjs`](./requirements-grill.workflow.mjs)                                           |   309 |             0 |         0 |       0 | curated · npm package · public repository |
| [`review/review.workflow.mjs`](./review/review.workflow.mjs)                                                     |   674 |             3 |         1 |      14 | curated · npm package · public repository |
| [`review-fix/review-fix.workflow.mjs`](./review-fix/review-fix.workflow.mjs)                                     |   630 |             0 |         1 |      18 | curated · npm package · public repository |
| [`excalidraw-pipeline/excalidraw-pipeline.workflow.mjs`](./excalidraw-pipeline/excalidraw-pipeline.workflow.mjs) |   673 |             3 |         0 |       2 | tracked only                              |

Three distribution levels, and they are independent:

- **Curated** means the name resolves through `/workflow-run <name>`. The
  registry is the explicit allowlist `CURATED_PACKAGE_WORKFLOW_NAMES` in
  [`extensions/_shared/workflow-runner.ts`](../../_shared/workflow-runner.ts) —
  exactly `live-smoke`, `requirements-grill`, `review`, `review-fix`. **Living in
  this directory registers nothing.**
- **npm package** means the exact file is listed in `package.json#files`.
- **Public repository** means the exact file is listed in `public-repository.json`.
  Both lists name regular files, never directories, so a new file under an
  already-public folder is not published implicitly.

`excalidraw-pipeline` is tracked in Git and absent from all three. It is a
worked reference for a long fan-out pipeline with a per-stage model pin; it is
not a curated workflow, not installed with the package, and not part of the
public repository export. Read it, copy from it, do not expect to run it by
name.

Adding a curated workflow is not a file drop: registry, tests, package
allowlist, manuals, support boundary, and changelog change together. See
[`docs/adr/curated-workflow-portfolio.md`](../../../docs/adr/curated-workflow-portfolio.md).

## What each example is for

| Example               | Product role                | Read it for                                                                                                                                                     |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`          | Child-session diagnostic    | The smallest complete workflow: two sequential read-only `agent()` calls, one input check, no schemas.                                                          |
| `requirements-grill`  | Requirements refinement     | Workflow-owned repository search (a bounded `rg` the script runs itself, not an agent), and fail-closed exits at every stage.                                   |
| `review`              | Evidence-backed code review | The staged text pipeline, a shaped `agent({ schema })` gate, a split-run operator handoff, **and** both halves of the prompt-placement rule in one file.        |
| `review-fix`          | Human-directed fixes        | A model-planned dependency graph that deterministic code validates and orders before any writer starts, one writer per finding, host-owned source fingerprints. |
| `excalidraw-pipeline` | Reference only              | Fan-out over many sections with per-section repair, and an explicit per-stage `model:` pin.                                                                     |

## Which authoring shape each one demonstrates

**Prompts.** Stage prompts are written inline in the script by default. A
neighboring `resources/<stage>.prompt.md` rendered through `promptFile()` is the
escape hatch for a role charter long enough to bury the routing — roughly 80
lines and up — or a prompt shared by more than one workflow.

| Example               | Prompt placement                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`          | Inline; the prompts are one line each.                                                                                                                                                                                             |
| `requirements-grill`  | Inline.                                                                                                                                                                                                                            |
| `review`              | Inline `COMMON` contract plus four stage tasks; `resources/interrogator.prompt.md` (92 lines) and `resources/verifier.prompt.md` (123 lines) stay external. This is the example to read when you need to see _both_ rules at once. |
| `review-fix`          | Inline `COMMON` plus every stage task. No `resources/` directory.                                                                                                                                                                  |
| `excalidraw-pipeline` | Three external prompt files, unmigrated.                                                                                                                                                                                           |

The four short `review` prompts and all five `review-fix` prompts moved inline on
2026-07-26 under the amendment recorded in
[`docs/adr/text-agent-results-and-prompt-resources.md`](../../../docs/adr/text-agent-results-and-prompt-resources.md).

**Shape versus meaning.** Lengths, counts, id patterns, and enums belong in
`agent({ schema })`, where a violation is re-asked by the runtime's retry.
Cross-field agreement, referential integrity, uniqueness, budgets summed across
items, and graph shape stay in script code, where they end the run.

| Example                            | Declared in the schema                                                                                          | Kept in script code                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review`                           | `CLARIFIER_SCHEMA`: question id pattern, ≤8 questions, ≤8 options, 500-character prompts, 200-character options | `decision` must agree with `questions`; ids and option labels unique; `recommended` must name a real option; 4,000-character combined prompt budget; blank-after-trim    |
| `review-fix`                       | `FINDING_SELECTOR_SCHEMA`: `^F[1-9][0-9]*$` ids, 1–20 findings, 8,000-character notes                           | Every id exists in the immutable review; no duplicate id or edge; no self-edge; dependencies must themselves be selected; acyclic; 32,000-character combined note budget |
| `live-smoke`, `requirements-grill` | — (no shaped stage)                                                                                             | Input bounds only                                                                                                                                                        |

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
