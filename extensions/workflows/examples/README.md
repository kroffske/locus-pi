# Shipped workflow examples

This directory is the only place where a reader can see the authoring shape that
[`AUTHORING.md`](../AUTHORING.md) and [`references/patterns.md`](../references/patterns.md)
teach, applied to code that actually runs. This file says what ships, what each
example is for, which shape it demonstrates, and how far it travels.

Measured 2026-07-28 against the files in this directory.

## What ships

Counts are of real occurrences — `promptFile()` calls, `agent({ schema })` calls,
and `throw` statements — not of the words where a comment happens to mention one.

| Example                                                                                      | Lines | `promptFile()` | Shaped calls | `throw` | Distribution                    |
| -------------------------------------------------------------------------------------------- | ----: | -------------: | -----------: | ------: | ------------------------------- |
| [`live-smoke.workflow.mjs`](./live-smoke.workflow.mjs)                                       |    51 |              0 |            0 |       0 | npm package · public repository |
| [`requirements-grill.workflow.mjs`](./requirements-grill.workflow.mjs)                       |   350 |              0 |            0 |       1 | npm package · public repository |
| [`review/review.workflow.mjs`](./review/review.workflow.mjs)                                 |   915 |              2 |            2 |       5 | npm package · public repository |
| [`review-fix/review-fix.workflow.mjs`](./review-fix/review-fix.workflow.mjs)                 |   696 |              0 |            1 |      10 | npm package · public repository |
| [`plan/plan.workflow.mjs`](./plan/plan.workflow.mjs)                                         |   477 |              0 |            1 |       1 | npm package · public repository |
| [`plan-implement/plan-implement.workflow.mjs`](./plan-implement/plan-implement.workflow.mjs) |   615 |              0 |            1 |       7 | npm package · public repository |

**This directory is the Package registry.** Every `<name>.workflow.mjs` in it
resolves through `/workflow-run <name>`, discovered by existence on each call
exactly like a project directory — there is no separate allowlist to keep in
sync. The scan descends one directory level, which is how a workflow keeps its
prompt resources and its diagram beside its entry, and it accepts only regular
files, so a symlink never resolves out of the package.

Two distribution levels remain, and they are independent of resolution:

- **npm package** means the exact file is listed in `package.json#files`.
- **Public repository** means the exact file is listed in `public-repository.json`.
  Both lists name regular files, never directories, so a new file under an
  already-public folder is not published implicitly.

Resolution and packing are pinned together by the repository test
`tests/integration/package-boundary.test.ts`, which is not packed:
the packed workflow names must equal the names this directory resolves. A
workflow added here without a `package.json#files` entry would run in a checkout
and be missing after `npm i`, which is the one way "the folder is the registry"
could lie to an operator.

Adding a file here is adding a Package workflow, so it is still a public-surface
change: the boundary test, the manuals, the support boundary, and the changelog
move with it. A worked reference you do **not** want registered belongs under
`extensions/workflows/references/` instead — that is where `excalidraw-pipeline`
lives, and why it runs by path only. Of that directory only
[`patterns.md`](../references/patterns.md) is packed.

This directory is also the only place a workflow can be both tracked and
resolvable by name: every other directory the resolver scans — `.pi/workflows/`,
`.claude/workflows/`, `.agents/workflows/` — is git-ignored in this repository,
so a copy placed there works on one machine and exists in no clone.

## What each example is for

| Example               | Product role                                                         | Read it for                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-smoke`          | Child-session diagnostic                                             | The smallest complete workflow: two sequential read-only `agent()` calls, one input check, no schemas.                                                                               |
| `requirements-grill`  | Requirements refinement                                              | The shortest declared roster — `scout`, `challenger`, `synthesizer` — in a straight line: three agents, no loop, no branch, and therefore no declared answer shape anywhere.         |
| `review`              | Evidence-backed code review                                          | The staged text pipeline, two shaped `agent({ schema })` gates, a split-run operator handoff, a bounded assessed loop, **and** both halves of the prompt-placement rule in one file. |
| `review-fix`          | Human-directed fixes                                                 | A model-planned dependency graph that deterministic code validates and orders before any writer starts, one writer per finding, an independent read-only check stage.                |
| `plan`                | Task → accepted plan                                                 | A declared agent roster — `scout`, `planner`, `critic` — and a bounded draft/critique loop whose exit is a shaped verdict rather than a human.                                       |
| `plan-implement`      | Accepted plan → reviewed changes                                     | The other end of a cross-run handoff: host-verified plan bytes, a persisted task ledger, and one sequential writer/reviewer repair loop per step.                                    |
| `excalidraw-pipeline` | Reference only, under `extensions/workflows/references/`, not packed | Fan-out over many sections with per-section repair, and an explicit per-stage `model:` pin.                                                                                          |

`plan` and `plan-implement` are a pair, and the seam between them is the point:
`plan` ends by returning the accepted plan text, which the runtime retains as
`plan.md`; `plan-implement` takes that artifact's complete
`{ runId, artifactId, name, sha256 }` reference through the workflow tool's
closed `continuation` control, which the host verifies and copies before any
workflow code runs. Since 2026-07-28 the entry no longer re-derives that proof
for itself: it requires exactly one non-empty `plan.md` reference and reads it.
The accepted cost is recorded in
[`docs/adr/curated-workflow-portfolio.md`](../../../docs/adr/curated-workflow-portfolio.md) —
a run can now start from a same-named draft of an earlier round rather than the
plan the critic accepted. `review` → `review-fix` is the older version of the
same seam, and since 2026-07-29 it makes the same trade: `review-fix` requires
exactly one non-empty `review.md` reference and reads it, instead of re-deriving
the host's digest proof and then asserting provenance the host cannot check.

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
`docs/adr/text-agent-results-and-prompt-resources.md`, which is not packed.

**Shape versus meaning, in three tiers.** Lengths, counts, id patterns, enums,
uniqueness and blankness belong in `agent({ schema })`. Cross-field agreement,
referential integrity, budgets summed across items and graph shape belong in
`validate` on the same call — script code that the runtime re-asks rather than
script code that ends the run. Only two classes stay fatal throws: self-reported
status, a model's verdict graded against its own findings, and evidence this
child did not produce (host-owned provenance, prior-run text).

That is why `review` now carries 4 fatal throws and `review-fix` 9, down from 14
and 18 on 2026-07-26. Every count down to 5 and 10 was a check moved into the DSL
rather than dropped; the last one each was dropped on purpose, by owner decision
6 of 2026-07-29 — see the `plan` / `plan-implement` seam above.

| Example                            | Declared in the schema                                                                                                                                                                                                                                                                         | Passed as `validate`                                                                                                                                                                  | Still a fatal throw                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `review`                           | `CLARIFIER_SCHEMA`: question id pattern, ≤8 questions, ≤8 options, 500-character prompts, 200-character options, unique ids, unique trimmed options, non-blank strings; `QUESTION_COVERAGE_SCHEMA`: `complete`/`more_questions_needed`, ≤8 gaps, 400-character gaps, unique trimmed, non-blank | `clarifierDecisionErrors` and `questionCoverageErrors`: the decision must agree with its list; `recommended` must name a real option; combined budgets                                | Continuation identity, operator-input bounds                     |
| `review-fix`                       | `FINDING_SELECTOR_SCHEMA`: `^F[1-9][0-9]*$` ids, 1–20 findings, 8,000-character notes, unique ids, unique dependencies                                                                                                                                                                         | `findingPlanErrors`: every id exists in the immutable review; no self-edge; dependencies must themselves be selected; acyclic; combined note budget                                   | Continuation shape, parsing the prior run's review, input bounds |
| `plan`                             | `PLAN_VERDICT_SCHEMA`: `accept`/`revise`, ≤12 defects, 600-character defects, unique trimmed, non-blank                                                                                                                                                                                        | `planVerdictErrors`: `accept` with defects and `revise` without them are both unusable; combined defect budget                                                                        | An empty task                                                    |
| `plan-implement`                   | `STEP_SELECTOR_SCHEMA`: `^S[1-9][0-9]*$` ids, 1–30 steps, 4,000-character notes, unique ids; `STEP_REVIEW_SCHEMA`: `accept`/`repair`/`blocked`, bounded summary and issues                                                                                                                     | `stepSelectionErrors`: every id exists in the accepted plan and combined note budget; `stepReviewErrors`: accepted tasks have no issues, repair/blocked tasks name at least one issue | Continuation shape, parsing the prior run's plan, input bounds   |
| `live-smoke`, `requirements-grill` | — (no shaped stage)                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                     | An empty request                                                 |

**Coverage is only as fine as the inventory that keys it.** `review` accounts for
its work by inventory id, so the id set is the ceiling on how fine every later
stage can be: units, questions, the coverage assessor's search, and the
verifier's ledger all inherit it, and none can recover a distinction the
inventory never drew. A live run on 2026-07-28 produced one id for a 384-line
new file, after which "every id accounted for" was true and meaningless — the
rendering and input layers of that file were never questioned. The inventory
prompt now says a path may carry several ids when a reviewer could accept one
part and reject another independently, bounded by `MAX_IDS_PER_PATH` and
`MAX_INVENTORY_IDS`, and the interrogator carries the matching bound on question
count. The two caps exist because the opposite failure is real on a weak model:
the interrogator must repeat the entire question set verbatim every round, and a
set it cannot reproduce exactly corrupts the ledger it feeds.

**Loops need a declared exit, not a scan.** Two shipped loops — `review`'s
interrogation rounds and `plan`'s drafting rounds — decide "again or done?" the
same way: the round's own reader returns a shaped verdict with the concrete gaps
or defects that justify another round, script code branches on the enum, and the
free text is handed to the next round verbatim. Neither greps the previous
round's Markdown, and both record which condition stopped them — the measured
verdict or the safety cap. `review` assesses its **last** round too, even though
no round can follow it: the verdict there is evidence rather than a branch, and
without it a run could only ever report "the cap stopped me", which reads the
same whether the question set was complete or the assessor was still arguing
with it. Gaps that survive the cap reach the verifier as declared limits of the
review, never as findings, because nobody asked a question about them.
`plan` used to carry a second, different loop — one
clarification round ended by an operator answering rather than by a judge. It was
removed on 2026-07-28: the run now records an open decision as a stated
assumption and plans on it, because a halted run yields no plan at all while a
written assumption can be read and corrected the moment the run finishes.

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

A diagram here is **one hand-authored SVG** named `<name>-pipeline.svg`, checked
in beside the entry it describes — inside the workflow's directory when it has
one, next to the entry file when it does not.
[`plan/plan-pipeline.svg`](./plan/plan-pipeline.svg) sets the shape and
[`requirements-grill-pipeline.svg`](./requirements-grill-pipeline.svg) follows
it. The remaining examples are undrawn; each is redrawn when its entry is next
reworked, not in a batch.

This replaces the generated triple that used to sit beside every example — a
generator, an Excalidraw document, and an exported PNG. Three files had to agree,
a rendering library that is not a dependency of this package had to be installed
to change anything, and the picture a reader actually opened was the one file
nobody could review in a diff. The generators, `.excalidraw` documents, and PNGs
were removed on 2026-07-28; nothing in this package produces or reads them.

What the SVG must show, because these are the things the source makes hard to
see at a glance:

- the deterministic script, one box per `phase()`, distinct from the agents;
- one box per child agent, under the exact `id` its roster declares, saying what
  it **receives** and what it **returns** — the handoffs are the pipeline;
- every artifact the run persists, under the name the code publishes it with;
- each branch and loop with its real exit condition, including the ones that end
  the run: an operator pause, a fail-closed stop, and the terminal result.

Keep it self-contained and diffable: no scripts, no embedded images, no remote
fonts or stylesheets, and a `<title>`/`<desc>` pair so it is readable without
sight of the picture. `tests/extensions/workflows/workflow-diagram-artifacts.test.ts`
pins those properties and checks the diagram against the workflow source, so a
renamed phase or a new artifact fails instead of quietly making the picture lie.
