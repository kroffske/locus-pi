# ADR: Curated Package workflow portfolio

- Status: accepted
- Date: 2026-07-17
- Amended: 2026-07-20, 2026-07-21, 2026-07-22, 2026-07-25, 2026-07-26

## Decision

The Package registry remains a strict allowlist. A workflow is curated only when
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
order and accountability explicit. Host-owned Git fingerprints bracket every
writer, check, and re-review boundary so later source drift is visible. A
separate host-enforced read-only child collects full-diff evidence and can run
only declared package scripts through `repository_check`; the host executes each
script in a disposable external worktree, never the operator checkout. The exact
complete script-name-to-command map is frozen before the first writer and checked
again before and inside the snapshot; additions, removals, changes, and newly
introduced `pre`/`post` lifecycle hooks are refused. Source fingerprints also include a dirty
submodule's checked-out HEAD. A fresh
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

## Consequences

The Package surface grew from three to five names, and then back to four when
`llm-smoke` retired with the primitive it proved (2026-07-21 amendment). It is
not a general automation catalog. The two review-family names expose one
deliberate sequence—question-led evidence, then a human-directed fix—while
keeping source mutation uncommitted and deployment outside the workflow boundary.

The remediation binding now covers the review artifact, not an editable path or a
working-tree snapshot. A complete digest-bound reference proves exactly which
review bytes remediation consumed; the selector's shaped result plus the exact
operator request prove which findings the workflow planned to address. It
deliberately does not claim that the current
working tree is byte-identical to the tree reviewed, because uncommitted work is
the common case. One writer per finding, independent check evidence, and a fresh
dependency-aware re-review make that drift visible before any completion claim.
