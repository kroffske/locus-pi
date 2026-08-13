# Shipped workflow examples

> These are complete supported jobs, not standard authoring templates. Some
> predate the exact-text/`choice` profile and deliberately retain advanced raw
> schemas or validators for compatibility. New workflow source uses one
> continuous Design -> review -> Build sequence: a raw request first writes and
> reviews `.pi/workflows/<name>/<name>.design.md`, then creates the matching root
> and declared direct child sources in the same folder. Only explicit `Design only` wording pauses after design;
> `Build design:` and `Build approved design:` remain Build-only compatibility
> forms. The source keeps only the nodes and mechanisms its reviewed graph needs.

This directory shows the complete jobs the package supports, including advanced
compatibility shapes that standard authoring no longer generates. This file says
what ships, what each example is for, which shape it demonstrates, and how far
it travels. The standard source profile lives in [`AUTHORING.md`](../AUTHORING.md)
and the skill-loaded compact pattern cards.

Measured 2026-08-13 against the files in this directory. `Profile` is literal
catalog metadata: `standard` is the current generated-source contract,
`legacy` preserves reviewed compatibility shapes, and `integration` names a
portfolio-level end-to-end flow.

`npm run check:workflow-source` validates the existing Package registry without
discovering or adding entries; today it applies the closed standard grammar to
`live-smoke`. Build checks a new standard file explicitly with
`npx @kroffske/locus-pi check-workflow-source <path>` from the project that owns
the file.

For the standard durable saved-child pattern—`invokeWorkflow()`, `outputDir()`,
and source-bound item checkpoints—see [`AUTHORING.md`](../AUTHORING.md).

## What ships

Counts are of real occurrences — `promptFile()` calls, `agent({ schema })` calls,
and `throw` statements — not of the words where a comment happens to mention one.

| Example                                                                                                      | Profile    | Lines | `promptFile()` | Shaped calls | `throw` | Distribution                    |
| ------------------------------------------------------------------------------------------------------------ | ---------- | ----: | -------------: | -----------: | ------: | ------------------------------- |
| [`implement/implement.workflow.mjs`](./implement/implement.workflow.mjs)                                     | `standard` |   240 |              0 |            0 |       0 | npm package · public repository |
| [`live-smoke/live-smoke.workflow.mjs`](./live-smoke/live-smoke.workflow.mjs)                                 | `standard` |    40 |              0 |            0 |       0 | npm package · public repository |
| [`requirements-grill/requirements-grill.workflow.mjs`](./requirements-grill/requirements-grill.workflow.mjs) | `legacy`   |   342 |              0 |            0 |       1 | npm package · public repository |
| [`review/review.workflow.mjs`](./review/review.workflow.mjs)                                                 | `legacy`   |   869 |              2 |            2 |       4 | npm package · public repository |
| [`review-fix/review-fix.workflow.mjs`](./review-fix/review-fix.workflow.mjs)                                 | `legacy`   |   590 |              0 |            1 |      10 | npm package · public repository |
| [`plan/plan.workflow.mjs`](./plan/plan.workflow.mjs)                                                         | `standard` |   153 |              1 |            0 |       0 | npm package · public repository |
| [`plan-implement/plan-implement.workflow.mjs`](./plan-implement/plan-implement.workflow.mjs)                 | `standard` |    54 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/post-code-review.workflow.mjs`](./post-code-review/post-code-review.workflow.mjs)         | `standard` |    83 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/scope.workflow.mjs`](./post-code-review/scope.workflow.mjs)                               | `standard` |    44 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/boundaries.workflow.mjs`](./post-code-review/boundaries.workflow.mjs)                     | `standard` |    27 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/simplicity.workflow.mjs`](./post-code-review/simplicity.workflow.mjs)                     | `standard` |    26 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/style.workflow.mjs`](./post-code-review/style.workflow.mjs)                               | `standard` |    26 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/contracts.workflow.mjs`](./post-code-review/contracts.workflow.mjs)                       | `standard` |    27 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/necessity.workflow.mjs`](./post-code-review/necessity.workflow.mjs)                       | `standard` |    32 |              0 |            0 |       0 | npm package · public repository |
| [`post-code-review/synthesis.workflow.mjs`](./post-code-review/synthesis.workflow.mjs)                       | `standard` |    28 |              0 |            0 |       0 | npm package · public repository |

**This directory is the Package registry.** Every `<workflow>/` folder owns a
matching `<workflow>.workflow.mjs` root and any direct child workflow files.
Roots run as `<workflow>`; children run as `<workflow>/<child>`. Discovery reads
the folders on each call, so there is no separate registry to keep in sync.

Flat `/workflow-run <name>` remains a compatibility alias for the canonical
`/workflows run <name>` form.

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

| Example               | Product role                                                         | Read it for                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implement`           | Prepared plan/review remediation                                     | Exact-text plan normalization, REQUIRED-by-default selection, no-op and human-decision routes, independent verification, and one bounded corrective pass.                                                       |
| `live-smoke`          | Child-session diagnostic                                             | The smallest complete workflow: two sequential full-tool `agent()` calls perform one file-listing action each, with one input check and no schemas.                                                             |
| `requirements-grill`  | Requirements refinement                                              | The shortest declared roster — `scout`, `challenger`, `synthesizer` — in a straight line: three agents, no loop, no branch, and therefore no declared answer shape anywhere.                                    |
| `review`              | Evidence-backed code review                                          | The staged text pipeline, two shaped `agent({ schema })` gates, a split-run operator handoff, a bounded assessed loop, **and** both halves of the prompt-placement rule in one file.                            |
| `review-fix`          | Human-directed fixes                                                 | A model-planned dependency graph that deterministic code validates and orders before any writer starts, one writer per finding, an independent read-only check stage.                                           |
| `plan`                | Task → repository map, plan, dynamic steps, and the execute script   | One reconnaissance agent writes `context.md`; one planning agent writes `plan.md` and complete `## S<n>` blocks in `steps.md`; one scripting agent renders `execute.workflow.mjs`.                              |
| `plan-implement`      | One exact step → changes, checks, and history                        | One implementation agent receives one complete step, changes only that scope, verifies it, and writes `history/S<n>.md`.                                                                                        |
| `post-code-review`    | Modular evidence-backed code review                                  | One external parent, one scope child, four independent parallel audit children, one sequential necessity challenge, and one synthesis child exchange complete Markdown files and publish `post-code-review.md`. |
| `post-code-review-*`  | Source-bound components of `post-code-review`                        | Inspect the exact scope, boundaries, simplicity, contracts, style, necessity, and synthesis prompts separately; normally launch the parent rather than one lane.                                                |
| `excalidraw-pipeline` | Reference only, under `extensions/workflows/references/`, not packed | Fan-out over many sections with per-section repair, and an explicit per-stage `model:` pin.                                                                                                                     |

`plan` and `plan-implement` are a pair, but no workflow calls the other, and a
finished `plan` run starts nothing. The installed `locus-task-workflow` skill
presents the planning files and stops; only after the operator approves in a
later turn does it give the main Pi agent one explicit `tmp/<select-name>`
workspace, append one single-line todo reference per dynamic `steps.md` block
without replacing unrelated todos, and start one top-level `plan-implement` run
with the exact matching block for each active todo. This keeps dynamic routing
and recovery in an agent that can read the documents semantically instead of in
JavaScript that would need to parse them.

`plan` also renders `execute.workflow.mjs` into that same workspace from the
fixed template in `plan/resources/execute-template.prompt.md`: one literal
implementation node per `## S<n>` block, then a summary node. It is an
unregistered draft that resolves only by explicit path, and the operator reviews
it before running it.

## Which authoring shape each one demonstrates

**Prompts.** Stage prompts are written inline in the script by default. A
neighboring `resources/<stage>.prompt.md` rendered through `promptFile()` is the
escape hatch for a role charter long enough to bury the routing — roughly 80
lines and up — or a prompt shared by more than one workflow.

| Example               | Prompt placement                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implement`           | Inline; every prompt and finite route remains visible in the source.                                                                                                                                                                |
| `live-smoke`          | Inline; the prompts are one line each.                                                                                                                                                                                              |
| `requirements-grill`  | Inline.                                                                                                                                                                                                                             |
| `review`              | Inline `COMMON` contract plus five stage tasks; `resources/interrogator.prompt.md` (136 lines) and `resources/verifier.prompt.md` (139 lines) stay external. This is the example to read when you need to see _both_ rules at once. |
| `review-fix`          | Inline `COMMON` plus every stage task. No `resources/` directory.                                                                                                                                                                   |
| `plan`                | Two inline stage prompts; `resources/execute-template.prompt.md` (167 lines) holds the scripting charter and the fixed execute-script template it fills.                                                                            |
| `plan-implement`      | One inline implementation prompt. No `resources/` directory.                                                                                                                                                                        |
| `post-code-review`    | Parent has no model prompt; all seven child prompts are inline in their own source files.                                                                                                                                           |
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

That is why `review` now carries 4 fatal throws and `review-fix` 10, down from 14
and 18 on 2026-07-26. Every move down to 5 and 10 was a check moved into the DSL
rather than dropped; `review`'s last one was dropped on purpose, by owner
decision 6 of 2026-07-29 — see the `plan` / `plan-implement` seam above.

| Example              | Declared in the schema                                                                                                                                                                                                                                                                         | Passed as `validate`                                                                                                                                   | Still a fatal throw                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `review`             | `CLARIFIER_SCHEMA`: question id pattern, ≤8 questions, ≤8 options, 500-character prompts, 200-character options, unique ids, unique trimmed options, non-blank strings; `QUESTION_COVERAGE_SCHEMA`: `complete`/`more_questions_needed`, ≤8 gaps, 400-character gaps, unique trimmed, non-blank | `clarifierDecisionErrors` and `questionCoverageErrors`: the decision must agree with its list; `recommended` must name a real option; combined budgets | Continuation identity, operator-input bounds                     |
| `review-fix`         | `FINDING_SELECTOR_SCHEMA`: `^F[1-9][0-9]*$` ids, 1–20 findings, 8,000-character notes, unique ids, unique dependencies                                                                                                                                                                         | `findingPlanErrors`: every id exists in the immutable review; no self-edge; dependencies must themselves be selected; acyclic; combined note budget    | Continuation shape, parsing the prior run's review, input bounds |
| `plan`               | — (no shaped stage)                                                                                                                                                                                                                                                                            | —; planning text stays opaque to JavaScript                                                                                                            | —; blank input becomes an explicit blocking task                 |
| `plan-implement`     | — (no shaped stage)                                                                                                                                                                                                                                                                            | —; one implementation result stays opaque to JavaScript                                                                                                | —; blank input becomes an explicit blocked step                  |
| `live-smoke`         | — (no shaped stage)                                                                                                                                                                                                                                                                            | —                                                                                                                                                      | —; blank input uses its documented default                       |
| `requirements-grill` | — (no shaped stage)                                                                                                                                                                                                                                                                            | —                                                                                                                                                      | An empty request                                                 |

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

**Loops need a declared exit, not a scan.** The remaining shipped assessed loop —
`review`'s interrogation rounds — decides "again or done?" through a shaped
verdict with the concrete gaps
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
[`requirements-grill-pipeline.svg`](./requirements-grill/requirements-grill-pipeline.svg) and
[`post-code-review/post-code-review-pipeline.svg`](./post-code-review/post-code-review-pipeline.svg)
are the current diagrams. The other examples are undrawn; the obsolete `plan`
critic-loop diagram was removed with that loop.

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
