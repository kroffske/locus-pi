# Changelog

This file records user-visible changes to the public package.

## Unreleased

### Added

- **Two curated Package workflows for planning and implementation: `plan` and
  `plan-implement`.** The
  authoring catalog described the loop shapes and the plan → build seam without
  shipping a runnable instance of either, so the only worked examples of a paused
  operator round and a cross-run artifact handoff were the review pair, which is
  about reviewing. `plan` turns one operator task into an accepted plan through
  two loops that fail differently: a clarification round that persists the exact
  task plus readable questions, declares an operator handoff and stops, and a
  draft/critique loop whose exit is the critic's shaped `accept`/`revise` verdict
  rather than a scan of the draft. Reaching the round cap without an acceptance is
  a failed run, which is also what keeps an unaccepted draft out of implementation.
  `plan-implement` consumes the accepted `plan.md` through the host's closed
  `continuation` control — proving it was the terminal result of a successful
  `plan` run, not a same-named draft from an earlier round — parses its `S<n>`
  step blocks deterministically, and gives each selected step one write-capable
  agent in the plan's own order, followed by independent checks and a fresh report.
  A failing writer skips the steps after it but still checks and reports, because
  the operator's working tree has already changed; that outcome returns
  `partial: true`, which the runner projects as a non-success.
  Both names are in `CURATED_PACKAGE_WORKFLOW_NAMES`, so `/workflow-run plan` and
  `/workflow-run plan-implement` resolve without any project file, and both ship
  in `package.json#files` and `public-repository.json` with the diagram triple the
  curated contract requires. The registry is the only route to a workflow that is
  both tracked in the repository and resolvable by name: every directory the
  resolver scans — `.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/` —
  is git-ignored, so a copy placed there works on one machine and exists in no
  clone. The portfolio decision and its criteria are recorded in
  [`docs/adr/curated-workflow-portfolio.md`](docs/adr/curated-workflow-portfolio.md).
  Every `plan` stage is read-only; `plan-implement` writes to the launch checkout,
  which is why it is a separate workflow the operator starts deliberately.
  One name collision is deliberate and documented: the `plan` **workflow** is not
  the `/plan` command of the `plan` extension and not the `plan` catalog agent.
  They occupy different namespaces and nothing resolves across them.

- **`/workflows result [runId|last]`** — the whole text a run finished with, in
  one command. Every finished-run surface is bounded deliberately: the chat digest
  caps a line at 160 characters because it enters model context, and the live
  panel clips to the terminal width. A run whose result _is_ prose — a review, a
  plan, an answer — therefore had no readable copy anywhere: the full text existed
  only as one escaped JSON string inside `result.json`, and reaching it meant
  walking run → stage → evidence → content in the evidence viewer and guessing
  which artifact held it. A prose result is now also written verbatim to
  `result.md` in the run directory, the digest and the panel name that file plus
  the command that opens it, and `/workflows result` (alias `/workflow-result`)
  shows the whole text in a scrollable read-only screen — `↑/↓` and
  PageUp/PageDown to scroll, Home/End to jump, Esc to close. Hosts without custom
  UI get a bounded preview plus the exact path. Structured results stay in
  `result.json`, which already pretty-prints them, and a run recorded before
  `result.md` existed is recovered from its persisted envelope so older runs still
  open.
- `/workflows result` and `/workflows status` accept the short run id every
  surface prints. Runs are shown as `run #98cc`, so that is what an operator has
  to type back; until now only the full `20260726-212752-98cc` resolved, and the
  short form reported the run as not found. `last` selects the newest run, a full id
  still resolves exactly, and a short suffix matching several runs is reported with
  the real match count and the listed candidates — never opened as the wrong run,
  and never reported as "not found" when runs were in fact found.
- Two per-call bounds on `agent()`, so a workflow script no longer re-implements
  them. `timeoutMs` is a wall-clock fuse that **aborts the child** on expiry and
  fails the call closed — `maxToolCalls` bounds tool usage and cannot end a
  stalled child, and a fuse that merely stopped waiting would leave a child
  burning tokens with nobody to read its answer. `maxAnswerChars` rejects an
  oversized answer at the call that produced it instead of letting it break the
  next stage's prompt. Replay: `timeoutMs` joins the canonical request (changing
  it is a different call, like `maxToolCalls`); `maxAnswerChars` stays a runtime
  gate applied to fresh and replayed answers alike, so old recordings remain
  replayable.
- `agent({ schema })` now supports the size and pattern bounds `minLength`,
  `maxLength`, `pattern`, `minItems`, and `maxItems`. Without them a workflow had
  to re-check every string and array by hand after validation already succeeded,
  and a violation could only throw — ending the run over an answer the child
  could have fixed. Expressed as schema keywords the same bound is handed back
  through the existing retry, so an over-long summary becomes correctable rather
  than fatal. Violations report the actual value, not just the limit, because the
  child has to decide what to cut.
  A bound on the wrong type, a negative or fractional bound, an
  unsatisfiable `min > max` pair, and a `pattern` that does not compile are all
  refused before the first child call. `pattern` follows the JSON Schema spec:
  unanchored, no flags.
- `agent({ schema })` now supports four uniqueness and blankness keywords:
  `uniqueItems: true`, `uniqueTrimmedItems: true`, `uniqueBy: "<property>"`, and
  `nonBlank: true`. A repeated finding id, a dependency listed twice, two option
  labels that differ only by surrounding whitespace, and a prompt that is nothing
  but spaces were all hand-written checks after validation returned, so each
  could only `throw` and end the run on an answer the child could have repaired.
  Declared instead, they join the existing schema retry: the child is told which
  element duplicates which — every later duplicate reports at its own index and
  names the first occurrence — and gets a second attempt.
  `uniqueItems` is restricted to arrays of `string`/`number`/`integer`/`boolean`
  items, with `uniqueBy` as the route for arrays of objects, because deep
  equality over objects would depend on the child's key order.
  `uniqueTrimmedItems` is strictly stronger than `uniqueItems` and exists for the
  common case where the script trims labels afterwards — plain `uniqueItems`
  accepts `["a", " a"]` and the normalizer then collapses them, shipping a
  duplicate the validator never saw. It cannot be declared beside `uniqueItems`.
  Both it and `nonBlank` canonicalize with `String.prototype.trim`, the same call
  a normalizer uses. Every misplaced or ill-formed declaration — a value other
  than `true`, an object item type under `uniqueItems`, a `uniqueBy` property
  that is not declared in `items.properties`, not listed in `items.required`, or
  not of primitive type — is refused before the first child call.
- `agent({ schema, validate })` — an optional script-supplied callback that joins
  the same retry loop the schema uses. A declared schema constrains one node;
  referential integrity, agreement between two fields, a budget summed across
  items and the shape of a graph are joins over the whole answer, and until now
  those were checked by ordinary script code after the `await`, where the only
  available verdict was a `throw` that ended the run having paid for every
  earlier child call. `validate` receives the parsed, schema-valid value and
  returns `string[]`; a non-empty return re-asks the child with those errors in
  their own labelled repair block, never merged into the schema bullet list —
  schema errors carry 0-indexed JSON paths and observed values, and one merged
  list would hand the child two index bases.
  It runs only after schema validation succeeds, so author code never receives an
  off-shape value, and it inherits the existing gating: no run on a child that
  failed, returned empty text, or overflowed `maxAnswerChars`. It requires
  `schema` on both the type and the runtime side, because the text overload has
  no parsed value to hand it. A call that declares it gets one dedicated extra
  attempt (3 rather than 2), unconditionally: the repair block must state a true
  budget in text that enters the replay key, and at render time nobody knows
  which authority will reject the next answer. A schema-only call is unchanged in
  every respect, including its rendered budget.
  The callback must be pure, synchronous and deterministic; it must not throw to
  signal a violation, must not transform the value, and must not call back into
  the DSL, which now throws. A throw from it is treated as an author bug: it
  propagates unchanged, consumes no retry, and is journaled as
  `{kind: "error", source: "script"}`. The runtime bounds what it returns — at
  most 32 errors, at most 500 characters each, no empty string, no Promise — and
  a breach fails the run closed rather than truncating, because truncating would
  silently rewrite the replay key.
  Replay: `validate` never joins the canonical request (`JSON.stringify` drops
  functions silently, so including it would fake key coverage), its body is
  covered by the existing script hash, and it **is** re-applied to replayed
  answers. When the current validator rejects a replayed answer the run fails
  closed, exactly as an over-long replayed answer does; re-asking would form an
  attempt-2 prompt whose key misses at that ordinal and silently convert a resume
  into a full live run. On a mismatch, `agent_end`'s `schemaValidation` now names
  the rejecting authority through `source: "schema" | "script"`, present only on
  calls that declared `validate`.
  Proven on a live host (`openai-codex/gpt-5.6-sol`), run `20260726-135149-d68a`:
  a real child violated a declared `uniqueTrimmedItems` bound, was told
  `tags[5]: trimmed value "deploy" duplicates item 4`, and returned six distinct
  tags on the retry; a script-authored rule the schema cannot state was rejected
  with `source: "script"` and repaired from its own bullet on the retry; an
  unsatisfiable validator consumed all three attempts and failed the run closed
  with no partial value. A companion measurement, run `20260726-135354-44aa`,
  sampled eight independent calls under the curated clarifier's declared bounds
  and recorded **zero first-attempt schema mismatches** — so the compounding
  failure the extra attempt guards against (a schema miss on attempt 1 leaving
  nothing for a cross-field miss on attempt 2) is uncommon on this host. That
  measurement did not use a deliberately weak model and does not by itself
  justify narrowing the budget; the unconditional form was chosen so the repair
  block can state a true budget, not to cover a high miss rate.
- `agent({ schema })` now supports `type: "integer"` — the most common JSON
  Schema type after `string`, previously rejected outright. A fractional answer
  is reported by value (`count: expected integer, got 2.5`) so the schema retry
  hands the child something it can act on, and an `integer` `enum` accepts only
  whole numbers. The declaration precheck still runs before the first child
  attempt and before any replay lookup, so widening the supported subset leaves
  every existing recording replayable.

### Fixed

- **`/ps` no longer stops opening for the rest of a session.** Pi owns a single
  editor slot, and mounting anything there detaches whatever was already
  displayed without disposing it or settling its promise. Every blocking
  operator surface in this package — the fleet selector, the agent viewer,
  `ask_user_question`, and a workflow's clarification question — shared one
  queue whose place was freed only when a component finished or was disposed. A
  component the host had silently replaced did neither, so it held the queue
  forever and every later `/ps` or question waited on something no longer on
  screen: the command was typed and nothing happened.
  The surface now models what the host actually does. The newest interaction
  that is genuinely able to mount takes the slot, and the one it replaces is
  failed with an explicit superseded error so its owner drops its own UI state
  instead of waiting. An interaction that cannot mount — a caller whose lease is
  gone, a host without custom UI — never supersedes: it waits its turn and
  leaves the live component alone, so a question that declines to appear cannot
  take an open fleet selector off the screen. The replaced component's host
  promise is deliberately left pending, because Pi's own close path restores the
  editor and would clear whatever replaced it.
  Leaving that promise pending is not sufficient on its own, and the first fix
  stopped one step short of the operator-visible symptom. A replaced component
  still holds the callback Pi handed it, and Pi keeps one such callback per
  `custom()` call for that call's whole life. When a superseded prompt calls it
  later — an `ask.timeout` expiring, an abort listener firing, a queued key — the
  host runs that old call's close path: `editorContainer.clear()` and the editor
  re-added, over whichever interaction is on screen at that moment. Answer a
  workflow's question, open `/ps`, and the fleet could be wiped from the screen
  with its own promise still pending: typed the command, nothing there.
  That callback is now fenced by slot ownership. A request that no longer owns
  the slot drops the call and disposes its own component instead, so no
  superseded surface can blank the live one, and the newest interaction stays on
  screen until it closes itself. For the same reason the slot changes hands only
  once the newcomer's factory has actually returned a component, so a request
  that never appears cannot take it from a live surface. A factory that _rejects_
  is the honest exception: Pi runs its own editor-restore on that path, so the
  live component is off the screen regardless — that incumbent is now explicitly
  retired and told, instead of being left awaiting a surface nobody can see.
  Callers now read supersession as replacement rather than failure: the ask tool
  returns `status: "superseded"` with a retryable message instead of
  `Ask UI failed`, and `/model-roles` closes benignly with any applied route
  intact.
  The trade this accepts: two genuinely concurrent interactions no longer queue,
  the later one wins. That is already what the host does to the rendered
  component; the queue only pretended otherwise, and the pretence is what froze.
  Sequential callers — a controller asking question 1 and then question 2 — are
  unchanged.
- `repository_check` can now actually run a declared check. It executes in a
  disposable worktree holding only tracked and untracked repository files, so the
  Git-ignored install tree was missing and every real check died at startup with
  `sh: vitest: command not found` — which a verifying agent reads as "the suite
  could not run", the one answer that makes the tool worthless. The snapshot now
  borrows the project's `node_modules` and `.venv` directories as symlinks when
  they exist, and unlinks them before removal so cleanup never deletes through
  them. Repository files are still isolated: a check that writes source touches
  only the disposable copy. The exception is a write inside a borrowed dependency
  root, which reaches the project's real install tree — package scripts remain
  trusted operator-owned code, and this is checkout isolation, not a sandbox.
- An operator widget on the string-array path no longer loses its controls to
  silent host truncation. That path rendered with no line budget while the host
  clamps it to ten lines by slicing the tail, so any block that wrapped past the
  cap — a workflow catalog in a deeply nested checkout, where absolute paths wrap
  across rows — reached the operator without the line naming the command to run,
  and without any sign that something had been dropped. The plain projection now
  applies the same degradation ladder the TUI path already used: body rows are
  shed first, then supporting metadata and hints, controls last, with a
  `(+N hidden)` marker for what went.
- A workflow run directory with no `result.json` now reads as an absent operator
  handoff instead of invalid evidence. A run that is still executing, or one that
  was interrupted, has no terminal result to carry a handoff, so the operator
  surfaces that scan run history no longer report it as corrupt. A `result.json`
  that exists but is a symlink stays invalid.
- `/workflow-run` now works in the one-shot output modes. Under `pi -p` (and
  `--mode json`) the command launched the run detached and returned; the host
  then disposed the session at the end of the turn, and the run died at its first
  child agent with "This extension ctx is stale after session replacement or
  reload". Those modes now hold the turn open until the run settles and its
  result is persisted, so a scripted `pi -p "/workflow-run <name>"` completes.
  `tui` and `rpc` sessions outlive their turn and keep the previous detached
  behavior — immediate return, live panel, cancellable through `/workflow-stop`.

### Changed

- **`review` asks its questions in assessed rounds, and every question id now
  carries its question.** Interrogation was one call: whatever the first reader
  thought of was the whole question set, and nothing ever checked whether a risk
  had gone unasked. It is now a bounded loop. After each round a separate
  read-only assessor reopens the units and the real code and returns the shaped
  verdict `{decision, gaps}` — `complete`, or `more_questions_needed` with up to
  eight concrete places where a reviewer could still be wrong and no question
  would catch it. Script code branches on that enum and hands the gap sentences
  to the next round verbatim; it never scans the interrogator's Markdown. Each
  round returns the complete question set rather than a delta, so the workflow
  still forwards one exact document, and every round is retained as its own
  `questions.md` plus the `question-coverage.json` that judged it. The loop is
  capped at three rounds and the last round is not assessed — a gap reported then
  would have no round left to close it — and the run journal records whether the
  assessor or the cap stopped it.
  Separately, `review.md` no longer refers to questions by id alone. `U2-Q3` is
  unreadable to someone who does not have `questions.md` open, so the verifier
  now quotes the interrogator's wording wherever it emits an id: in each finding's
  `Question:` line, under each resolution heading, and in the coverage ledger. The
  interrogator does the same in its reconciliation, withdrawals, and gap notes,
  and the clarification handoff carries each question's id together with its full
  prompt.
- **A workflow run now reads as one run in the session transcript.** Two runs of
  the same workflow used to arrive as two identical, undelimited blocks titled
  `[locus-workflow-event]` — a name that says neither what the block is nor when
  it appears — and every agent appeared twice, once as `started` and once as
  `finished`. Runs are now delimited by their own boundary: a `── workflow <name>
· run #<id> · <state> <time> ─────` rule opens both a launch banner and the
  closing digest, so a reader can tell the current run from the one above it
  without reading the text. Each agent occupies one row that is rewritten in
  place when it ends. The custom message type is now `locus-workflow-run`, which
  names the object rather than the emission moment; it is also the marker the
  model sees, so the rename applies to both readers at once.
  The launch banner is the only new send, and it is sent only when a synchronous
  idle recheck passes: Pi routes a message to `agent.steer()` while streaming
  regardless of `triggerTurn:false`, so a busy session gets no banner rather than
  a steered agent. Live per-event messages remain impossible for the same reason;
  the below-editor panel and `/ps` stay the surfaces for watching a run.
  Three things the block used to leave out are now stated: an agent that started
  and never ended keeps an explicit `no end recorded (evidence missing)` row
  instead of vanishing from a green run; replayed work carries `↻ … replayed from
run #<source>` instead of a success glyph, with the source run id the digest
  previously dropped; and a run that stops for a human renders that gate as its
  own block naming the stage, the tool, the questions, and the pending answer,
  with a continuation run opening as `↳ continues run #<source>` plus the answer
  that unblocked it.
- **An agent that ran twice is no longer two identical entries.** Rows from the
  last few completed runs stay inspectable, so a re-run agent appeared once per
  run: the fleet list read as one confused fleet, and typing the agent's name
  was rejected as ambiguous. The list now ranks the newest run and every
  standalone agent first, puts earlier runs behind a single `earlier workflow
runs` label, and resolves a bare agent name to that agent's row in the newest
  run — so opening an agent shows the dialog of the run being watched, not a
  finished one. Nothing is hidden: an earlier run is still reachable through its
  own row id.
- **A question that stops a workflow now says which run it stopped.** The block
  asking for an answer stated the question and the workflow's title but not
  which run was blocked or what opened the gate, which is unreadable when more
  than one thing is running. It now carries `workflow <name> · run #<id> ·
awaitOperator` — as a body line rather than a badge, because a narrow terminal
  keeps only the first badge and dropping either the provenance or the question
  counter is worse than one extra line. It names the stage and the tool, never a
  guessed agent: the stored handoff records no asking agent.
- **The curated `review` and `review-fix` examples now demonstrate the shape the
  documentation teaches.** The review family was previously exempt from the
  inline-prompt default because it predated it — provenance, not a property.
  Measured against the criterion that same rule already states (a role charter of
  roughly 80 lines and up), 0 of `review-fix`'s 5 prompt files and 2 of
  `review`'s 6 qualified. The exemption is replaced by that measurement:
  `review-fix` ships no prompt resources, and `review` inlines four stage tasks
  under one `COMMON` contract while keeping `resources/interrogator.prompt.md`
  and `resources/verifier.prompt.md`. Nine `*.prompt.md` files leave the package.
  This matters beyond tidiness: the runtime records a prompt's SHA-256 but never
  compares it to an expected value, so editing a packaged prompt file changed
  what a curated workflow did while its script identity stayed the same. Inline
  prompt bytes are covered by the snapshot the runner already verifies. Recorded
  cost: the two surviving charters still restate the capability and AST Index
  paragraphs the script now owns, so those copies can drift; the review test
  pins the shared sentences on both sides.
- **Both review entries moved their answer bounds into `agent({ schema })`.**
  `review`'s clarifier declares the question id pattern, the 1–8 question count,
  the 500-character prompt limit, and the option count and length; `review-fix`'s
  selector declares the `F<n>` id pattern, the 1–20 finding count, and the
  8,000-character note limit. A violation is now handed back to the child by the
  schema retry instead of ending a run that had already paid for earlier stages.
  Free-text handoffs use each call's `maxAnswerChars`, so an oversized answer
  names the stage that produced it. Nothing was dropped: seven checks that merely
  restated `type:` were deleted as unreachable, eleven became schema keywords,
  and every cross-field, referential, uniqueness, budget, and graph invariant
  stays in deterministic script code — those still end the run, because no re-ask
  can fix a plan that contradicts its own source.
- **The four curated pipeline diagrams are readable.** Each was one horizontal
  lane roughly 5,400–5,900 units wide, rendering as a 3:1–4:1 strip whose text
  was illegible at fit-to-window. Every generator now wraps that authored strip
  into two stacked bands; authored coordinates are unchanged, and only a
  `bandX`/`bandY` transform moves them, so the sources stay diffable. New
  dimensions: `live-smoke` 2680×2231, `requirements-grill` 2559×2818, `review`
  2740×2750, `review-fix` 3240×2750. Regenerated from source, and the review pair
  no longer labels prompt resources it no longer ships.
- `extensions/workflows/examples/README.md` is new: one place that says what
  ships, what each example is for, which authoring shape it demonstrates, and
  whether it is curated, in the npm package, in the public repository, or —
  like `excalidraw-pipeline` — tracked only.

### Fixed

- `review-fix`'s shared prompt contract no longer hands two stages an
  instruction they cannot obey. It told every stage to reopen the live checkout
  — impossible for the no-tool selector — and described every answer as a
  next-stage handoff, contradicting the terminal re-reviewer's own task of
  writing the reader-facing `re-review.md`. Capability and audience are now
  stated by the stages where they are true. Found by running the migrated
  `review` workflow against the migrated `review-fix` source on a live host.
- `review-fix` again forwards a permitted empty planner note to its writer
  unchanged. The selector schema allows `note: ""` and the selector prompt
  recommends it; a truthiness fallback introduced during the inline migration
  replaced that empty note with a placeholder.

- Workflow authoring now defaults to inline stage prompts. A workflow is one
  file: a shared contract constant, each stage's task written next to the
  `agent()` call it belongs to, its capability options, and the routing between
  them — read in one pass, with the retained script snapshot covering the prompt
  bytes. A neighboring `*.prompt.md` through `promptFile()` becomes the escape
  hatch for a long role charter or a prompt shared by more than one workflow.
  The pattern catalog's staged-pipeline skeleton, the authoring pointer, and the
  canonical DSL notes now teach the same shape.
- The `/workflows` Edit/Review editor handoff now names `workflow-author`, the
  catalog agent bundled in `.agents/agents/` and installed with this package,
  instead of the skill `$pi-workflow-authoring`, which no installation ever
  provided. The prefill therefore points at a surface that exists after
  `pi install` and is reachable as `/agent run workflow-author`; a test asserts
  the named agent resolves in the bundled catalog so the pointer cannot rot.
- `review` handoffs now pass forward as exact text. The entry orchestrates and
  bounds — non-empty text and per-stage character caps — and no longer grades
  Markdown grammar: coverage ids, unit ledgers, and reconciliation sections are
  prompt discipline the interrogator and verifier reconcile and report, not host
  gates that end a run after several model calls. Shaped answers that must be
  machine-read keep using `agent({ schema })`, where the runtime re-asks the child
  with the validator errors before failing closed.
- An empty review scope now completes instead of failing. The `review` change
  inventory declares `## No changes` with its reason when nothing changed — a
  clean worktree under an unstaged-changes scope, for example — and that
  declaration alone ends the run with a `no-changes` result instead of spending
  unit planning, interrogation, and verification on nothing.
- A failed workflow run now says where it broke and what to hand a repairing
  agent: the failing stage, the owning script path, the failing stage's answer
  artifact, and the run journal. `result.json`, `/workflows status <runId>`, the
  tool result, and the persisted run message also carry one copyable repair
  request; the width-clamped live widget shows the pointers. A deliberate
  `{ ok: false }` verdict stays a domain result and gets no repair request.
- The live workflow panel now shows the whole agent roster instead of a single
  current row: settled agents keep their outcome marker and duration, the running
  agent is highlighted, and declared stages the run has not reached yet stay
  visible as planned work with the detail from `meta.phases`. A loop that
  re-enters a stage updates that agent's row and marks its round instead of
  appending a duplicate; on a short terminal the oldest settled rows collapse
  behind an announced `(+N earlier agents)` line.
- Pi 0.82.0 is now the minimum workflow host. All four Pi peer ranges start at
  0.82.0 and local development packages are pinned to that exact version, so
  tool-origin workflow questions can wait for the terminal `agent_settled`
  lifecycle event instead of opening during an intermediate turn.
- Actionable workflow pauses now appear directly in the primary Pi editor and
  continue the exact source run through verified artifacts, unchanged
  target/script identity, and one atomic claim. Multiple questions serialize
  oldest-first with `Question 1 of N`; Escape snoozes without cancelling, bare
  `/workflows` reopens the pending question, and source `result.json` remains
  immutable. TUI supports inline selection/custom text, RPC uses native
  bidirectional UI requests, and JSON/print requires an explicit answer.
- Workflow lifecycle is now explicit instead of inferred from `ok`. Runs persist
  `completed`, `awaiting_operator`, `cancelled`, or `failed`; the review
  clarification handoff keeps its existing payload but renders as waiting.
  `/workflows stop [runId|last]` now reaches both slash- and tool-launched runs,
  while workflow rows remain inspectable without `x` or Escape cancellation.
  The Escape guard also covers the interval before a tool-launched workflow
  creates its first live child row.
  Tab completion exposes the supported command grammar, workflow names, run ids,
  `last`, and resume ids while leaving query/path/input tails as free text.
- Cross-run text consumption now requires the exact reference in the successful
  source run's terminal handoff projection; index-only artifacts fail closed.
  Read-only repository checks materialize initialized submodule source in their
  disposable worktree, and remediation fingerprints distinguish dirty
  same-HEAD submodule byte changes even while the submodule remains at its
  recorded gitlink. Corrupt persisted result envelopes now project as
  `unknown`, not as an evidenced failure.
- Blocking custom UI now follows one inline interaction contract: selectors,
  catalogs, and viewers replace the editor area instead of overlaying scrollback,
  then restore editor focus when the interaction closes. Ask result cards now
  return a real TUI component, so selecting with Enter no longer crashes Pi.
  Plan mode is
  session-explicit: startup clears stale/persisted activation, bare `/mode` only
  shows state, Shift+Tab no longer changes mode, and the active badge/border use
  the warning accent. Workflow catalog `Start` now prefills direct
  `/workflows run <name>` execution; only Edit/Review route through
  `$pi-workflow-authoring`.
- **Breaking, before release:** narrowed workflow semantic `input` to one
  optional string of at most 16,000 characters. The removed generic object form
  has no compatibility adapter. Cross-run state now uses a separate closed
  `continuation` tool control with one origin and 1–8 complete digest-bound
  artifact refs; the runtime verifies and copies them before workflow code or a
  child starts, records the exact source/current binding as the first journal
  event, and rejects combination with replay-only `resumeFromRunId`.
- Structured agent decisions now validate their schema declarations recursively
  before a child starts. Unsupported types/keywords and malformed declarations
  fail with zero child calls, and text-agent options cannot carry a schema under
  a `Promise<string>` type. `review` uses this boundary for its clarifier;
  `review-fix` uses it for an agent-selected remediation DAG whose ids, notes,
  edges, cycles and stable topological order are checked before writers.

### Added

- Added `excalidraw-pipeline` as a repository-local workflow example that turns a
  free-form diagram intent into a rendered Excalidraw PNG. It is not a curated
  Package workflow and is not in the npm allowlist, so the installed package
  surface is unchanged; it exists as an authoring reference for operators writing
  their own pipelines. Because the engine has no in-run human gate — `ask` refuses
  without a UI and workflow child sessions are headless — the pipeline is split
  into two runs around an edited artifact, the same shape as `review` and
  `review-fix`: `draft` writes one request file and stops, the operator sets
  `approved: yes`, and `build` refuses to start otherwise. The build run fans out
  one agent per diagram section; a section agent writes a restricted graph source
  file that the workflow executes in a separate process and judges by whether it
  runs, so agent text is never parsed as a protocol and hard execution errors are
  fed back for a bounded number of repairs. Composition, health checking, and
  rendering are deterministic workflow code, so the acceptance gate never depends
  on model judgement: a run is accepted only when `assertDiagramHealthy` reports
  zero errors and zero warnings and a non-empty PNG exists, and a missing
  generation package or renderer stops the run before the first child session
  exists. The generation package resolves globally and is deliberately not a
  dependency.
- Added first-class `/workflow-run`, `/workflow-stop`, `/workflow-list`,
  `/workflow-info`, `/workflow-status`, and `/workflow-continue` commands for
  Pi-native filtering and Tab selection. Existing `/workflows <subcommand>`
  forms remain compatible; continuation and replay keep separate semantics.
- Added a compact interactive workflow inspector. `/workflows run` now starts
  one background run per session/project and returns the editor immediately;
  `/workflows stop [runId|last]` requests cancellation without claiming a
  terminal result early. The passive below-editor widget shows the declared,
  reached, and current stage frontier plus one active child through the shared
  agent row renderer. `/ps` opens the full shared fleet: parallel groups remain
  context-only, leaf `Enter` opens readable child output, and `Esc` returns
  without aborting. Workflow children stop only through `/workflows stop`;
  standalone agent children retain confirmed `x`. Replayed
  children show only digest-verified answer artifacts when no transcript exists;
  stale UI and transcript callbacks are revoked on `session_shutdown`. The
  programmatic `workflow` tool remains awaited.
- `/workflows run <name> --resume <runId>` is now a real replay instead of a
  metadata link. Every `agent()` call whose ordinal position and fully resolved
  request match the recorded run returns the recorded child text without
  spawning a child, so iterating on the last stage of a long pipeline no longer
  pays for the earlier stages. Replay is a strict prefix: the first mismatched
  call invalidates itself and every later call. `dsl.now()` and `dsl.random()`
  are new DSL primitives whose values are recorded and replayed, which is how a
  workflow stays nondeterministic and resumable at the same time; a script that
  calls `Date.now()` / `Math.random()` directly is not rejected, it is simply
  detected by the AST scan and never recorded or replayed. Replay is refused
  with a named reason when the script bytes changed, when identity coverage is
  `entry-only`, when the script is not replay-safe, or when no record exists —
  and every refused or unresolvable call runs for real. A run that reused
  recorded calls is marked `replayed` in `journal.ndjson`, in the `result.json`
  replay envelope, in `/workflows status`, and in the live progress panel, and a
  replayed call reports no token usage, so a green rerun can never be mistaken
  for fresh evidence.
- Added the curated `review` Package workflow as a question-led agent pipeline.
  A shaped read-only clarifier decides whether semantic text can continue or
  needs an operator pause. A pause persists exact intent/questions; a later text
  answer call attaches both complete refs through host continuation. Five sequential
  read-only agents resolve scope, inventory every changed surface, group material
  review units, ask falsifiable questions, and independently verify them. The
  runtime, not a publisher agent, persists the exact final answer as `review.md`
  under the workflow run. Deterministic `C<n>` reconciliation rejects inventory
  ids dropped by later agents, and fixed context limits fail closed on oversized
  intent, clarification, handoffs, or reports. Continuation also requires the
  successful paused run's terminal result to name the same complete intent and
  question refs; index kind/stage metadata alone cannot
  manufacture a prepare handoff. Only confirmed problems become findings.
- Added the read-only `ast_index` agent tool. Read-only child sessions that ask
  for it get allowlisted `ast-index` navigation commands executed with argv and
  no shell; `clear`, `watch`, unknown commands, and output-file options are
  rejected, and the index database stays in the user cache directory. The
  review stages that trace code relationships prefer it and fall back to
  `grep`/`find` when the binary or index is unavailable.
- Added the curated `review-fix` workflow as the remediation half of the same
  question-led shape. Semantic text supplies the request while host continuation
  supplies one immutable `{runId, artifactId, name, sha256}` `review.md` ref. A
  no-tool read-only agent selects 1–20 finding units and dependencies through a
  shaped answer; deterministic code rejects invalid ids, notes, edges, cycles,
  and ordering before writers. One sequential writer owns each selected
  finding. Host-owned Git fingerprints bracket each writer and later check, so
  source drift is explicit. A separate host-enforced read-only checker can run
  only package script commands frozen before the first writer in disposable
  external worktrees; the complete script map is frozen and rechecked, so
  writer-added, removed, or modified commands and `pre`/`post` lifecycle hooks
  are refused. Source
  fingerprints include dirty submodule HEAD, index, status, and changed bytes. The review input must equal the
  source run's terminal result and be its exact terminal projected ref, so
  changing artifact-index stage metadata cannot promote another file. A fresh
  read-only agent re-reviews every original finding, affected dependency, and
  regression risk. Runtime-owned `agent({ artifact })` answers replace the old
  helper and publisher stages. Changes remain uncommitted in the launch checkout.
- Added a canonical per-run artifact index at
  `.locus/runtime/workflows/<runId>/artifacts/index.json`. Every `agent()` attempt
  persists its exact answer and, for fresh child sessions, its transcript and
  result envelope. `publishArtifact()` writes deterministic workflow-authored
  text; `consumeTextArtifact()` verifies and copies a complete prior-run text
  reference; `agent({ artifact: "name.md" })` gives an automatic answer a stable
  reader-facing name. `/workflows dashboard` and interactive status commands now
  browse persisted run, stage, artifact, transcript, result, and log evidence with
  digest verification before content is shown.
  Completed runs and the model-callable workflow tool also expose a bounded list
  of complete answer/published refs, with an explicit omitted count, so the next
  workflow can consume an actual ref instead of guessing an artifact id.
  Consumed text also carries the validated source terminal result/ref projection
  for consumers that must prove a report was the run's actual final output.
  The store validates the complete physical directory chain from the project
  root through `.locus/runtime/workflows/<runId>` before reads and writes, so a
  symlinked `.locus`, `runtime`, or deeper ancestor cannot redirect evidence.
- Made persisted journal evidence discriminated by event kind: required and
  allowed fields are checked before projection, so malformed rows such as an
  empty `agent_end` remain diagnostics. Child cancellation now bounds its wait
  for a non-settling SDK `abort()` acknowledgement and continues evidence
  persistence afterward.
- Made `public-repository.json#repositoryFiles` an exact-file allowlist.
  Directory entries are rejected, so future files under public folders require
  an explicit manifest and inventory change.
- Documented the project-local ignored planning and testing workflow boundary.
  Local dogfood exercises split-run plan consumption and independent testcase
  design, implementation/execution, and failure attribution without entering
  Git, the curated Package registry, or the public npm package. Its independent
  planning verifier and test attribution stages are host-enforced read-only,
  use `repository_check` instead of shell, and fail closed on bounded context or
  work-unit limits.
- Added workflow-local `promptFile()` resources with strict variable rendering,
  source-relative confinement, immutable run copies, and SHA-256 evidence.
- Added per-call `readOnly: true` policy for workflow agents so prompt-only
  stages can retain host-enforced capability narrowing without local agent
  definitions or the ability to broaden a catalog read-only role.
- Enforced `readOnly: true` for child-agent sessions with a strict capability
  allowlist. Curated review readers now use a dedicated non-shell `git_read`
  query tool; shell, write/edit, nested workflow, unknown tools, and mutating
  Git commands are blocked before execution.
- Added runtime-owned `workspace()` handles for sharing one exact linked
  worktree safely across workflow agents.
- Recorded the strict curated-workflow selection criteria and candidate boundary
  in `docs/adr/curated-workflow-portfolio.md`.
- Added editable Excalidraw.js pipeline maps and PNG previews for every curated
  Package workflow, with explicit operator, workflow, agent, decision, and
  persisted-artifact ownership.
- Added opt-in session todo auto-continuation: a persisted queue context,
  `/todo run` and `/todo pause`, and one hidden Pi continuation turn after each
  successful queue transition.
- Added atomic `/todo append` batches with `;;` separators and a 20-item limit.

### Removed

- **Breaking:** removed the workflow DSL's `llm()` primitive. `agent()` is now
  the only way a workflow reaches a model. The direct one-shot pi-ai completion
  path (`completeSimple` / `streamSimple`), its options and result types, the
  `llm_start` / `llm_end` / `llm_delta` journal kinds, and the synthetic `llm`
  live row are all gone. A saved workflow that calls `dsl.llm()` now fails at
  run time. Replace a cheap gate, classification, or draft with a no-tool child
  under a declared shape — `agent(prompt, { schema, tools: [], maxToolCalls: 0 })`
  — which keeps one execution path, one journal shape, and one retry budget. Two
  model-calling surfaces forced an author to choose one before writing a stage,
  and a constrained reused agent is not meaningfully more expensive than a direct
  call. The JSON-Schema subset validator, the shared `SCHEMA_MAX_ATTEMPTS` budget,
  and `SchemaValidationError` survive as `agent({ schema })`'s machinery.
- **Breaking:** retired the `llm-smoke` curated Package workflow. The curated
  registry is now four names: `live-smoke`, `requirements-grill`, `review`, and
  `review-fix`. Its only job was proving `llm()` routing, and nothing was folded
  into `live-smoke`; see the 2026-07-21 amendment in
  `docs/adr/curated-workflow-portfolio.md`.

### Changed

- The run-level token/cost budget in `/workflows status` is now summed from
  `agent_end` usage instead of `llm_end` usage, and the per-run `llm=…` counter
  is gone. Journals written before this change still parse; their `llm_*` lines
  are no longer counted or specially rendered.

- Made the package English-only end to end. Child agents are prompted in
  English, so the evidence honesty check no longer matches Russian claim verbs
  and the `requirements-grill` search-term extractor no longer carries Russian
  stop words. An operator writing in another language states the request through
  the parent agent, which hands the child an English task.
- Translated the public documentation surface to English. The docs map, the
  agent-execution trust-model ADR, the extension manual index, and the manuals
  for `agents`, `ask-user-question`, `ast-structural-edit`, `devext-doctor`,
  `loop`, `model`, `security-gate`, and `todo-context` were partly written in
  Russian; every published manual is now English-only. Behavior, command names,
  tool names, and permissions are unchanged.
- Agent execution now has one output contract: the exact final non-empty child
  text. `spawn_agent` and `task` accept one required `task` string and create one
  child. Model-written result markers, JSON envelopes, agent schemas, parser
  retries, and batch `tasks:[]` were removed; runtime metadata remains in
  details, journals, and result artifacts.
- Separated `review` and `review-fix` into independent workflow directories,
  with each entrypoint, local Markdown prompts, and pipeline diagram beside its
  owner. The former shared YAML/config loader, paired local agent files, and
  stale review-family diagrams were removed.
- Hardened curated review completion for large cumulative diffs. Review agents
  now share one visible 1,000-call runaway fuse and workspace configuration
  instead of repeating small per-stage budgets. Workflow entrypoints also carry
  IDE-only `WorkflowDsl` type links so JavaScript-aware editors can navigate
  `agent()`, `promptFile()`, `phase()`, and `log()` to their definitions.
- Kept the supported curated Package registry at four workflows. Generic
  planning, testing, implementation, release, deploy, and incident workflows
  remain project-local; the narrow review remediation family is human-gated by
  an immutable review reference plus an agent-selected, deterministically
  validated finding graph and never commits.
- Kept review and fixing as separate workflows. Clarification may pause one run
  and continue through host-verified artifacts in a later call, but remediation
  still starts independently and receives no write authority from the review run.
- Added an executable diagram contract so future curated workflows cannot ship
  without a reproducible generator, editable source, preview, ownership legend,
  and actual runtime persistence surfaces.
- Hardened the curated review agents for large comparisons by budgeting
  evidence calls, batching read-only inspection, excluding local `.tasks/`,
  `.locus/`, and prior reports from review evidence, and preserving explicit
  limitations instead of exhausting the runtime before producing a report.
- Session todo autonomy now fails closed on missing progress, transport
  failure, empty queues, or the 20-continuation safety limit while preserving
  remaining queue state.

## [0.2.1] - 2026-07-17

### Added

- Added the `dev` integration branch contract, tracked local Git hooks, a pull-request template, and executable CI policy checks for task and release pull requests.

### Changed

- Defined `task branch -> dev -> main` as the repository delivery path, with routine work squash-merged into `dev` and releases merged from `dev` into `main`.
- Corrected packaged documentation links and extension manifest test evidence,
  with an executable check that rejects missing documentation or test paths.
- Kept maintainer source-audit archaeology in the public GitHub repository
  while removing it from the installed npm documentation surface.
- Updated contribution, support, security, and install guidance for the public
  MIT-licensed release.

### Security

- Pinned GitHub Actions to reviewed commit SHAs and ignored local `.npmrc`
  credential configuration.

## [0.2.0] - 2026-07-14

### Added

- Added an executable npm package-boundary test that compares the real tarball
  with the approved allowlist, verifies all ten entrypoints and local imports,
  and loads the packed entrypoints from an unpacked candidate.
- Added public contribution, support, security, conduct, and CI contracts for
  release review.
- Added the MIT license, retained third-party notices, and final repository/npm
  metadata for `@kroffske/locus-pi`.

### Changed

- Limited the npm candidate to the ten default Pi extensions, their explicit
  runtime and documentation closure, and the three curated Package workflows:
  `live-smoke`, `llm-smoke`, and `requirements-grill`.
- Moved the AST search, preview, and resolve implementations under the active
  `ast-structural-edit` owner.
- Reduced production dependencies to the packages required by the public
  runtime surface.

### Removed

- Removed beta modules, uncurated workflow examples, reports, galleries,
  transcripts, benchmarks, evaluations, archives, and private runtime or
  planning paths from the npm candidate.
- Removed the repository-only `pi-live-terminal` executable from the npm
  package boundary.

### Security

- Verified the candidate with secret scanning, production dependency audit,
  source tests, and actual tarball inspection. These checks are evidence, not a
  substitute for the remaining human release gates.
