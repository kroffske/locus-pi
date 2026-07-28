# ADR: Curated Package workflow portfolio

- Status: accepted
- Date: 2026-07-17
- Amended: 2026-07-20, 2026-07-21, 2026-07-22, 2026-07-25, 2026-07-26, 2026-07-27 (x2), 2026-07-28 (x2)

## Decision

~~The Package registry remains a strict allowlist.~~ (See the second 2026-07-27
amendment: the registry is now the shipped `examples/` directory, scanned by
existence.) A workflow belongs in it only when
it is useful across repositories, has a stable and bounded input/output contract,
produces inspectable evidence, fails closed when evidence is unavailable, and has
a permission posture that the package can support as a public promise.

The accepted Package portfolio is:

| Workflow             | Product role                | Why it belongs                                                                                                                                                                    |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Child-session diagnostic    | It proves the installed host can create real child sessions with a minimal read-only run.                                                                                         |
| `requirements-grill` | Requirements refinement     | It turns a recurring cross-project intake problem into a bounded structured handoff.                                                                                              |
| `review`             | Evidence-backed code review | It preserves exact operator intent, supports explicit split-run clarification, and produces a digest-bound runtime-owned report.                                                  |
| `review-fix`         | Human-directed fixes        | It lets a shaped selector turn an immutable review into a validated dependency graph, gives each selected finding one writer, and independently checks and re-reviews the result. |
| `plan`               | Task to accepted plan       | It turns one free-form task into an ordered plan no reader has to trust, because a read-only critic accepted it against the repository, and it stays read-only throughout.        |
| `plan-implement`     | Accepted plan to changes    | It executes one host-verified plan with a writer per step in the plan's own order, then checks and reports independently of the writers.                                          |

`review` keeps review and remediation separate. It is an agent pipeline, not an
evidence adapter. Since the 2026-07-26 amendment to
[the prompt-resource ADR](./text-agent-results-and-prompt-resources.md), each
stage's prompt is written inline in the entry file under one shared `COMMON`
contract, and a neighboring `resources/*.prompt.md` survives only for a role
charter too long to inline — `review` keeps two, `review-fix` keeps none. Every
prompt, inline or not, still contains the stable stage role plus the dynamic
per-run handoff. A non-empty string remains a one-shot review. The
workflow persists that exact intent, then five sequential read-only children
resolve scope, inventory the changed surface, group material review units, ask
falsifiable questions, and independently reopen evidence to answer them.
Questions are hypotheses: only what the verifier confirms becomes a finding.
The runtime entry reconciles unique inventory `C<n>` headings against an
exact-once unit ledger and mandatory question/final coverage sections. It also
bounds intent, clarification, every intermediate handoff, and the final review;
model wording cannot hide a dropped coverage id or expand context without limit.

The shaped clarifier adds an explicit two-run clarification without replacing
the one-shot path. A fresh run publishes exact `intent.md`, asks one read-only
child whether operator input is required, and returns both complete artifact
references only when it pauses. A continuation run receives those refs through
the host-owned continuation field plus the operator's non-empty text answers; it
verifies/copies both and persists the answers before starting the same five-stage
review. The source run's terminal result must name both complete refs, and both
must appear in its validated artifact projection; mutable index stage metadata
alone is insufficient. The workflow runtime publishes every
durable handoff and the verifier's exact final answer as `review.md`. There is no
publisher agent, task-local report, model-written status envelope, or inferred
lossy intent.

The five inspection calls set `readOnly: true`. The SDK host turns that per-call
policy into a capability allowlist: shell, write/edit, nested workflow, and
unknown tools are unavailable. Git inspection uses package-owned `git_read`;
code-relationship stages may also use allowlisted `ast_index`, degrading to
`grep`/`find` when unavailable. Private-forge authentication and repository
operations therefore stay inside the existing agent/tool environment rather
than creating a provider-specific integration.

`review-fix` separates operator meaning from host state. `input` is only the
exact semantic request; closed host continuation supplies one complete immutable
`{runId, artifactId, name, sha256}` reference to `review.md`. Runtime consumption verifies
the successful source run, full reference, digest, confinement, media type, and
bytes, then copies the review into the new run with source lineage. Deterministic
entry code additionally requires the referenced bytes to equal the successful
source run's terminal string result and the exact ref to be its last projected
output. A no-tool read-only selector returns 1–20 `{id,note,dependsOn}` units.
Deterministic code bounds every handoff, selects complete `### F<n>` blocks,
rejects invalid ids, edges and cycles, and computes stable topological order
before any writer starts.

One read-only resolver narrows the selected fix scope. Exactly one sequential
writer then owns each selected finding in the launch checkout, which makes mutation
order and accountability explicit. A
separate host-enforced read-only child collects full-diff evidence and can run
only declared package scripts through `repository_check`; the host executes each
script in a disposable external worktree, never the operator checkout. The exact
complete script-name-to-command map is frozen before the first writer and checked
again before and inside the snapshot; additions, removals, changes, and newly
introduced `pre`/`post` lifecycle hooks are refused. A fresh
read-only child re-reviews every original finding, affected dependency, and
regression risk.
The runtime automatically persists the named answers `scope.md`,
`worker-F<n>.md`, `check-evidence.md`, and `re-review.md`; the last is also the
workflow result. There is no imported input helper, unit planner, verifier/
publisher pair, `fix-report.md`, or task-local publication. Both review entries
therefore keep default `self-contained-static` identity, which now covers every
`review-fix` prompt byte and all but the two `review` charters. Runtime still
snapshots each separately loaded prompt and records its SHA-256; it does not
compare that digest to an expected value, which is why an inlined prompt is the
default and a charter file is the exception.

Both entries declare answer shape in `agent({ schema })` rather than re-checking
it after the fact: `review`'s clarifier declares the question id pattern, the
1–8 count, and the prompt/option lengths, and `review-fix`'s selector declares
the `F<n>` id pattern, the 1–20 count, and the note length. A violation is
re-asked by the runtime's schema retry instead of ending the run. What stays in
deterministic entry code is what a declared keyword cannot express: ~~agreement
between fields, referential integrity against the immutable review, uniqueness,
budgets summed across items, and graph acyclicity.~~

**Amendment, 2026-07-26 (Status stays `accepted`).** Uniqueness is struck from
that list because the runtime now expresses it. `uniqueItems`,
`uniqueTrimmedItems`, `uniqueBy`, and `nonBlank` joined the supported schema
subset, and both curated entries declare them — `uniqueBy: "id"` plus
`uniqueTrimmedItems`/`nonBlank` on `review`'s clarifier, `uniqueBy: "id"` plus
`uniqueItems` on `review-fix`'s selector — so a repeated question id, a repeated
dependency, two option labels that differ only by whitespace, and a
whitespace-only prompt are all re-asked rather than fatal. The rest of the list
is unchanged and still fatal. The amendment narrows the claim on the merits: the
original justification (a re-ask cannot fix a plan that contradicts its own
source) never applied to uniqueness, which involves no source.

**Second amendment, 2026-07-26 (Status stays `accepted`).** Migrating the two
curated entries is W6-class work and was gated on an explicit owner decision,
because a curated workflow's observable failure behaviour changes: a cross-field
violation that used to end the run on the child's first answer now costs up to
three child runs before failing closed. **The owner approved that migration on
2026-07-26**, after reading the independent review that priced it — the schema
keywords absorb six of the seventeen candidate checks, leaving twelve, and the
prior decision recorded below had to be narrowed rather than repealed. This
paragraph is the approval record; there is no separate artifact. The remainder of that
list is struck too, and for the same reason applied one level up: the original
sentence conflated "the script owns this rule" with "this rule ends the run", and
those are now separable. `agent({ schema, validate })` lets a script hand the
runtime a `(value) => string[]` callback that joins the existing retry loop, so
**agreement between fields, referential integrity against the immutable review,
budgets summed across items, and graph acyclicity now stay out of the schema but
inside the retry loop.** Both curated entries migrated: `review`'s clarifier
passes `clarifierDecisionErrors` and `review-fix`'s selector passes a closure over
`findingPlanErrors`, and each of the eleven checks those two functions used to
throw now reaches the child as a bullet before the call can fail closed.

What genuinely stays fatal is narrower than the struck list and is defined by a
different test — not "the script computes it" but "can a bullet handed back to the
model offer it a second way to satisfy the check":

- **self-reported status**, where the check accepts the model's word about
  something the host did not verify;
- **verdict coherence**, where a model's verdict is graded against its own
  findings list and both "fabricate a finding" and "flip the verdict" satisfy it;
- **host-owned continuation, provenance and identity evidence**, and text a
  _prior_ run's agent wrote — neither is this child's to repair.

A deterministic membership, uniqueness, sum or graph re-check over data the model
does not control is explicitly NOT in that class: it runs identically on every
attempt, so the only move it offers is compliance. The barrier keeping the unsafe
cases out is documentation plus a pinning test in
`tests/extensions/workflows/review-workflow.test.ts` and
`review-remediation-workflows.test.ts`; the mechanism itself cannot tell the two
apart, and this ADR says so rather than claiming a guarantee it does not have.

The canonical evidence owner is
`.locus/runtime/workflows/<runId>/artifacts/index.json`. Automatic answers and
fresh child transcripts/result envelopes share the same digest-bound index with
workflow-published and consumed text. This makes the report inspectable through
the persisted run viewer and makes cross-run approval immutable without requiring
the reviewed working tree itself to be committed. Writers still leave source
changes uncommitted and do not commit, push, create a pull request, merge,
deploy, or discard unrelated work.
The artifact owner validates every physical directory from the resolved project
root through `.locus/runtime/workflows/<runId>` before artifact I/O; symlinked
ancestors cannot relocate the canonical evidence root outside the project.

## Amendment 2026-07-21 — the portfolio drops to four with `llm-smoke`

`llm-smoke` was the direct-model diagnostic in the table above. It is retired,
and the accepted portfolio is now four names. The reason is not that the workflow
was weak: it is that the thing it proved no longer exists. `llm()` — one direct
pi-ai completion with no child session and no tools — was removed from the DSL by
owner decision (T-108), because two model-calling surfaces forced an author to
choose one before writing a stage, and a reused catalog agent constrained to a
fixed answer shape is not meaningfully more expensive than a direct call. A
curated workflow whose entire contract is "prove primitive X routes correctly"
cannot outlive primitive X.

**Nothing is folded into `live-smoke`.** `llm-smoke` exercised four things: a
plain completion, a system prompt, a streamed completion (`llm_delta`), and
`schema=` validation. The first three are properties of a call path that has been
deleted; there is no surviving surface to point them at. The fourth moved to the
runtime boundary as `agent(prompt, { schema })`, which appends a shape contract to
the child prompt, validates the child's exact final text with the same JSON-Schema
subset validator, retries within `SCHEMA_MAX_ATTEMPTS`, and throws
`SchemaValidationError` rather than returning a partial value. That contract is
proven at source level by `tests/shared/workflows/workflow-agent-schema.test.ts`.

Extending `live-smoke` with a shaped stage was considered and rejected here.
`live-smoke`'s curated contract is exactly "two read-only child agents, each doing
one small tool action" — the minimum that proves child-session creation on a live
host. Adding a schema stage would change its public result shape and its cost
inside a removal task, for a check that is about validation logic rather than host
capability. The portfolio criterion is a stable bounded contract, not maximal
coverage per workflow.

**Named residual gap.** No curated workflow now exercises `agent({ schema })`
against a live host, so the weak-model behaviour of the shape contract — does a
weak model actually produce conforming JSON within two attempts, and does the
fail-closed path read correctly to an operator — is unproven outside the test
suite. This is a `live-host-proof` gap, recorded rather than closed: closing it is
a live-smoke concern to decide on its own merits, not a side effect of deleting a
primitive.

## Amendment 2026-07-25 — actionable review clarification

The `review` portfolio shape now declares its clarification as a generic
versioned operator handoff after persisting `intent.md` and
`clarification-questions.md`. This does not add a fifth curated workflow or a
review-specific host protocol. The shared workflow runtime projects the oldest
question directly in Pi, verifies the two declared artifacts and unchanged
self-contained-static script identity, atomically claims one continuation, and
reuses the ordinary workflow launcher.

Escape snoozes the question without cancelling the source run; bare
`/workflows` reopens it, and `/workflow-stop` remains the only cancellation
path. `/workflow-continue` is distinct from replay-only `--resume`. Pi 0.82.0 is
the minimum host because tool-origin projection relies on the terminal
`agent_settled` lifecycle event. TUI is inline-interactive, RPC uses native
bidirectional UI requests, and JSON/print requires an explicit answer.

## Selection boundary

The following shapes are not curated now:

- Generic plan/build/fix orchestration remains project-local. The curated
  exception is the narrow review family: it has one readable source report, an
  immutable digest-bound review reference, explicit human-selected finding ids,
  a deterministic input gate before any write-capable child, one writer per
  finding, independent check/re-review evidence, and no commit or remote action.
- Planning and testing lifecycle examples remain ignored under `.pi/workflows/`.
  They prove split-run planning and independent testcase design,
  implementation/execution, and attribution locally; they are not tracked
  examples, registry entries, or public package files.
- Release and deploy workflows remain project-local because providers,
  credentials, rollback, and blast radius are not package-neutral.
- Incident-response workflows remain project-local because infrastructure access
  and evidence sources vary by operator environment.
- A future `test-triage` workflow is a candidate only after it has a
  language-neutral target contract, bounded logs, and proof that it adds value
  beyond ordinary repository commands.

Repository or user workflow files remain the proving ground for new shapes.
Existence under an examples directory does not promote a workflow; registry,
tests, package allowlist, manuals, support boundary, and changelog must change
together. `public-repository.json` lists exact regular files rather than
directories, so a future file below an already public folder is not selected
implicitly.

## Amendment 2026-07-27 — the portfolio grows to six with `plan` and `plan-implement`

**The owner approved promoting both on 2026-07-27**, after they shipped as tracked
examples and the catalog made the cost of that status concrete: every directory
the resolver scans — `.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/`
— is git-ignored, so a workflow that lives in the repository and resolves by name
has exactly one route, and it is this registry. This paragraph is the approval
record; there is no separate artifact.

They are judged against the same five criteria as the rest of the portfolio.
_Useful across repositories_: "turn a task into a plan" and "carry a plan out" are
not project-specific, and neither reads a project-specific contract. _Stable
bounded contract_: `plan` takes one semantic string and returns the accepted plan
text; `plan-implement` takes one semantic string plus exactly one digest-bound
`plan.md` reference and returns the report text. Every handoff, operator input,
and consumed artifact is bounded, and every agent answer is bounded by its own
call's `maxAnswerChars`. _Inspectable evidence_: the runtime owns `task.md`,
`context.md`, one `plan.md` and one `plan-critique.json` per drafting round, then
`step-selection.json`, `scope.md`, one `worker-S<n>.md` per attempted step,
`check-evidence.md`, and `implementation-report.md`. _Fails closed_: a plan the critic never accepted
ends the run `ok:false`, which is also what keeps it out of implementation, since
continuation consumes only a successful run's projected artifacts; a failed writer
returns `partial: true`, which is projected as non-success. _Supportable permission
posture_: every `plan` stage is `readOnly: true`, and in `plan-implement` only the
per-step writers hold `write`/`edit`/`bash` while the selector holds no tools at
all.

The seam between them is the same one `review` → `review-fix` established, with
one check added. `plan-implement` requires the consumed bytes to equal the source
run's terminal result, not merely to carry the right name, stage, and digest —
because `plan` writes one `plan.md` **per drafting round** under the same logical
name, and only the last one was accepted. Name plus stage plus a valid digest
would happily bind a draft the critic rejected. That check is deterministic and
fatal: it is host-owned provenance about a prior run, which is exactly the class
this ADR keeps outside the retry loop.

Both entries follow the schema/`validate`/throw split the 2026-07-26 amendments
settled. `plan`'s clarifier and critic and `plan-implement`'s step selector declare
their counts, lengths, id patterns, enums, uniqueness and blankness in
`agent({ schema })`; `clarifierDecisionErrors`, `planVerdictErrors`, and
`stepSelectionErrors` carry the cross-field agreement, referential integrity
against the host-parsed plan, and the summed budgets as `validate` callbacks that
join the retry loop. What stays fatal is continuation provenance, prior-run text
this run cannot re-ask for, and operator-input bounds.

**Named residual risk.** `plan` is a curated workflow name that reads like the
`plan` extension's `/plan` command and like the `plan` catalog agent. They occupy
different namespaces and nothing resolves across them, but an operator reading
`/workflow-run plan` next to `/plan` has to know that. The alternative — a longer
name nobody would type — was judged worse than one documented collision.

## Amendment 2026-07-27 (second) — the directory replaces the allowlist

**The owner replaced `CURATED_PACKAGE_WORKFLOW_NAMES` with a scan of
`extensions/workflows/examples/` on 2026-07-27.** A Package workflow is now
registered by the existence of its `<name>.workflow.mjs` file in that directory,
discovered on every resolve/list/info call exactly like a project directory.
There is no allowlist. This paragraph is the decision record.

What this repeals is the sentence at the top of this ADR — "the Package registry
remains a strict allowlist" — and only that. The five portfolio criteria stand,
and the promotion decision above is unchanged; what changed is the _mechanism_
that admits a workflow, not the judgement about which workflows belong. The
honest reason is cost, and it was measured on this repository: promoting two
workflows touched a registry constant, a relative-path map, the package
allowlist, the public-repository inventory, six test files, five manuals, the
support boundary, and this ADR — for a change whose entire content was "these two
files are runnable by name". Everything on that list except the constant and the
path map is still required, because they are the parts that describe a public
surface. The two that are gone were bookkeeping that duplicated the filesystem.

**What replaces the allowlist as the safety property.** An allowlist could refuse
a file that was dropped into the directory; a scan cannot. The compensating
boundaries are these, and they are weaker in exactly one way that is stated here
rather than glossed:

- The scan descends **one** directory level and accepts only `entry.isFile()`, so
  a symlink is never followed out of the package and support material nested
  deeper is never mistaken for an entry point.
- `package.json#files` still decides what an install ships, and
  `tests/integration/package-boundary.test.ts` now asserts that the packed
  workflow names equal the scanned names. A workflow added to the directory and
  not packed fails the build rather than resolving in a checkout and vanishing
  after `npm i`.
- That same test keeps a reviewed snapshot of the expected names, so adding or
  removing a file in the directory still fails until a human updates it. This is
  the honest replacement for the allowlist: not "the host refuses it", but "the
  build refuses it until somebody looks".
- What is genuinely lost: a file present in the directory of a _checkout_ — a
  work-in-progress example, a fixture — is resolvable by name in that checkout
  before any test runs. The mitigation is that this directory is now documented
  as the registry rather than as an examples folder, and a workflow that should
  not be registered belongs under `extensions/workflows/references/`, which is
  where `excalidraw-pipeline` moved as part of this amendment.

The name of this ADR is now slightly wrong: "curated" describes the portfolio
judgement, not the mechanism. It is kept because the file is linked from the
manuals, the support boundary, and two changelog entries, and a redirect costs
more than the imprecision.

## Amendment 2026-07-28 — `plan` names its agents and stops asking

Two changes to the planning pair, both accepted by the maintainer against a
stated cost.

**The cast is declared.** `plan` now carries a frozen `PLAN_AGENTS` roster —
`scout`, `planner`, `critic` — where each entry holds the agent's id, what it
receives, what it returns, and its capability options; the call sites spread
those options and add only the round label. The four participants previously
existed only as `agent()` calls inside async functions, labelled with verb
phrases, and the names printed on the workflow's diagram matched no identifier in
the source at all. This is a legibility decision, not an architecture one: the
control flow is unchanged, and the host script still owns the sequence.

**The operator pause is removed.** The shaped clarifier, the operator handoff,
and the continuation that resumed a paused planning run are gone. An open
decision is now recorded by the planner in the plan under `## Assumptions` in the
form "assumed X, because Y; wrong if Z", and the critic counts a decision the
plan depends on but never states as a defect while a stated one is not. The
reasoning: a paused run yields no plan until somebody answers it, while a written
assumption is visible the moment the run finishes and is corrected by replanning,
which this workflow is cheap enough to repeat. The clarification shape stays in
`review`, where the answer changes what is reviewed at all.

**`plan-implement` no longer re-derives provenance.** It still requires exactly
one non-empty continuation artifact named `plan.md`, but the entry-code
checks on digest, source target, source stage, and terminal result are gone. The
cost is real and is accepted here rather than hidden: that terminal-result check
was what distinguished the accepted plan from a same-named draft of an earlier
drafting round, so an implementation run can now start from a plan the critic had
not accepted. Weighed against it, the ceremony sat in front of every reader of
the entry and every author imitating it, and the failure it prevented is repaired
by replanning rather than by anything irreversible. The plan's length bound went
with them for a simpler reason: it could only reject a plan that had already been
accepted, and the per-step budgets are what keep a stage's prompt bounded.

## Amendment 2026-07-28 (second) — `requirements-grill` stops searching for its own agents

**The script-owned repository search is deleted.** `requirements-grill` used to
run one `rg` itself before spawning anything: it extracted up to five keywords
from the operator's request against a hard-coded list of twenty-seven English
stop words, rewrote `workflow`/`workflows` to `workflows?` as a special case,
fell back to the literal string `workflow` when it matched nothing, ordered a
hard-coded list of directory names against whatever the checkout happened to
contain, and handed the resulting lines to three children that held no tools at
all. That is deleted, and the workflow's first two agents now hold
`read`, `git_read`, `ast_index`, `grep`, and `find` under host-enforced
`readOnly: true` — the same bounded read-only set every `plan` stage already
ships with. This is not the capability suspension the 2026-07-21 direction entry
allowed: no stage gains shell, write, or edit, and the third stage still holds no
tools at all, because it only composes two texts it was handed.

Three reasons, in order of weight. The guess was worse than the search: an agent
with those tools looks up the repository's own vocabulary, while the extractor
could only match the words the operator happened to use. The guess was
English-only — `.locus/soul.md` names search-term extraction as an English-only
heuristic under _known traps_, and this removes one instance of it. And it was
the sole reason ripgrep on `PATH` was an install requirement of this package;
that line is gone from `README.md`.

What is given up is stated rather than glossed: the search is no longer
deterministic. The old `rg` ran with fixed arguments and returned the same lines
for the same request, and a replay could reproduce it exactly. Now the coverage
of the first stage depends on the model, which is the trade this package makes
for every other agent stage it ships. The compensation is structural rather than
scripted: the `challenger` reopens the files the `scout` names before relying on
them, so a thin or wrong context map is contradicted by evidence rather than
propagated into the handoff.

**The cast is declared, and nothing branches.** The three participants are now a
frozen `GRILL_AGENTS` roster — `scout`, `challenger`, `synthesizer` — each entry
holding its id, what it receives, what it returns, and its capability options,
exactly as `plan` does. Two capability sets exist and each is written once. No
stage declares an `agent({ schema })` shape, and that is deliberate: this
workflow is a straight line with no loop and no branch, so there is no decision
for a declared shape to carry, and adding one would be ceremony. The
`validate-input` and `collect-context` phases are gone with the search; an empty
request throws before the first child.

The entry no longer bounds the request's length either. It used to refuse
anything over 12,000 characters, while both surfaces that can start a workflow —
the run command and the model-callable tool — already refuse anything over
`WORKFLOW_INPUT_MAX_CHARS`. A second, stricter number in script code cannot
protect a stage the host's own bound does not already cover; all it can do is
refuse a request the operator was permitted to send, with a reason that appears
in no documentation. **The owner extended the same removal to `plan` on
2026-07-28**, where the number was a copy of the host's rather than a stricter
one and the check was therefore unreachable. Both entries now refuse only an
empty input, which narrows the "operator-input bounds" clause of the 2026-07-27
amendment's fatal-throw list: what stays fatal in these two entries is the
absence of the one thing the run cannot start without, not its size.

## Amendment 2026-07-28 (third) — what one live end-to-end run changed

The planning pair and `review` were run end to end against a fresh sandbox
repository on a mid-tier cloud model. The produced application worked and the
review returned zero findings, and both were honest: the transcripts show every
stage opening the files it cited. What the run exposed is weakness in scrutiny,
and three prompt-level fixes follow from it. They are recorded here because each
one narrows a claim this ADR already makes.

**Coverage accounting is only as fine as the inventory that keys it.** `review`
proves its thoroughness by accounting for every inventory id. The run's inventory
returned one id for a 384-line new file, and units, questions, the coverage
assessor and the verifier's ledger all inherited that granularity, so the
accounting identity held while the rendering and input layers were never
questioned. The inventory prompt now permits — and bounds — several ids per path,
keyed to independent acceptability rather than to file count. The bound is not
decoration: the interrogator is required to repeat its entire question set
verbatim each round, so an inventory split without a ceiling produces a set a
weak model cannot reproduce, and an unreproducible set corrupts the ledger that
the coverage claim rests on. `MAX_IDS_PER_PATH`, `MAX_INVENTORY_IDS` and the
interrogator's per-unit and total question limits are that ceiling.

**A loop that cannot report its exit honestly is not an inspectable loop.** The
interrogation loop broke before assessing its last round, on the reasoning that a
verdict nobody can act on is wasted. The run showed the cost: the record says
"stopped at the round cap" whether the question set was complete or the assessor
was still naming gaps, and those two are not the same review. The last round is
now assessed, the verdict is evidence rather than a branch, and surviving gaps
reach the verifier as declared limits — never as findings, because no question
was asked about them. This costs one child call in the runs that reach the cap.

**A judge that calls a broken contract a matter of taste is not a gate.** The
critic accepted a plan whose every step omitted the mandatory `Depends on:` line
that `plan-implement` parses, while its own reasoning transcript named two
separate problems it then did not report. Its defect list now names a missing
mandatory step line and a verification that cannot pass at its own place in the
order. Relatedly, the planner may no longer discharge a step's verification with
"the observation that proves it worked": that clause licensed six manual checks
in one run, after which the independent checker could rerun nothing and the
reporter had to grade every step partial. A step now states one command a later
agent can rerun, with the output that proves it, and a human observation only
where the step says why no command can exist.

A second run repeated the same three workflows on a 4-bit local model with no
thinking mode, against a documentation task rather than a code-writing one. The
three fixes above held on that model — the inventory returned one id per document
section instead of one per file, the final round was assessed and its surviving
gap recorded, and every step carried a rerunnable command, which is why the
implementation report read "implemented" rather than the previous run's blanket
"partial". Three further weaknesses surfaced and are closed here.

**A step is one changed thing.** That run's plan opened with a step that only
read nine files, then wrote three independent document sections in one step. The
first is not work an implementer can be given and the second hides three
independent pieces of evidence behind one verification. The planner is now told
both, and the critic's defect list names both, because a rule only one of them
knows is a rule the other cannot enforce.

**A verdict must agree with its own findings.** The same run's review confirmed a
blocking finding and still returned "ready for human acceptance". No script code
grades that — the review's verdict is prose, by design — so the rule lives in the
verifier's charter: one confirmed blocking or should-fix finding means "needs
changes", and "blocked" stays reserved for a scope that could not be inspected.
This is the self-grading class this ADR keeps outside the retry loop elsewhere,
and here it has no mechanical guard at all; the prompt sentence and a pinning
test are the whole of it, which this paragraph states rather than glosses.

**Plumbing stopped leaking into the product.** The surviving coverage gaps were
handed to the verifier inside a delimited block, and the verifier reproduced the
block's marker as a heading in the finished review. Gaps now belong in the
review's own prose about what it did not cover.

A third run, the same task on the same local model, tested those three fixes and
returned a split result worth recording, because the half that failed would have
read as a success. The ban on steps that change nothing held: the fake "read nine
files" step was gone. The rule that several things of the same kind get one step
each did the opposite of its intent — with the fake step gone the plan collapsed
into a single step covering all three sections, and the critic accepted it,
reasoning in writing that one step for three extensions is justified because the
task asks for one new file. The escape hatch for work that genuinely cannot be
done apart was closed with the wrong key: a shared destination passed for a
reason. Both roles are now told that it is not one. The remaining two fixes could
not be exercised at all — that review found no findings, so no verdict could
contradict them, and its question loop closed with no surviving gap, so no marker
block reached the verifier.

A fourth run carried that sentence plus a deliberately falsified document: the
same task, the same local model, with three false claims planted in the finished
file before the review — a version the manifest contradicts, an enforcement
claim the source contradicts, and a measured per-call cost no source can settle.
The plan split into one step per documented subject again, and the review
returned "needs changes" against its own two confirmed findings, which is the
first live evidence for the verdict rule above. Two caveats belong in the record:
the review's own clarification round named both planted claims before any
question was written, so this run does not show it would have found them
unaided; and the question set closed complete in one round again, so the marker
leak remains untested on a live run.

Three further weaknesses surfaced, each one the same shape — a rule the model
kept while defeating it — and each is closed by naming the escape rather than
restating the rule.

**A closing verification step changes nothing.** The accepted plan ended with an
"integrity pass" that re-ran what each step's own verification already proves.
The ban on steps that change nothing did not read as covering a step called a
verification, so both roles now carry the consequence: the plan ends with the
last step that changes something.

**The inventory does not own scope.** It saw the split, orphaned block the
implementation had itself reported, judged it structural rather than a content
error, and wrote it in prose around the returned document. Nothing downstream
reads that prose, so a real observation reached nobody while the finished review
read as complete coverage. Everything the inventory notices now takes an id,
with the doubt stated inside the entry, and the prompt says plainly that text
outside the document is lost.

**An unfalsifiable claim still gets a question.** The planted timing claim drew
no question, no finding, and no declared limit. The fix is not a new section —
the interrogator's `## Gaps not closed` reaches only the coverage assessor —
but a question that resolves: does anything in the repository support this
claim? A claim nothing supports is a finding, and asking is the only outcome
that cannot silently pass.

Not changed, and deliberately: the verifier's `Confirmed`/`Rejected`/`Unresolved`
vocabulary reads backwards to a human when a positively phrased question is
answered `Rejected`, but it is a readability defect rather than a decomposition
one, and it is left for its own change.

## Consequences

The Package surface grew from three to five names, back to four when `llm-smoke`
retired with the primitive it proved (2026-07-21 amendment), and to six with the
planning pair (2026-07-27 amendment). It is
not a general automation catalog. The four non-diagnostic names expose two
deliberate sequences — question-led evidence then a human-directed fix, and an
accepted plan then a step-by-step implementation — while
keeping source mutation uncommitted and deployment outside the workflow boundary.

The remediation binding now covers the review artifact, not an editable path or a
working-tree snapshot. A complete digest-bound reference proves exactly which
review bytes remediation consumed; the selector's shaped result plus the exact
operator request prove which findings the workflow planned to address. It
deliberately does not claim that the current
working tree is byte-identical to the tree reviewed, because uncommitted work is
the common case. One writer per finding, independent check evidence, and a fresh
dependency-aware re-review make that drift visible before any completion claim.
