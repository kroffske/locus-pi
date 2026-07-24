# Changelog

This file records user-visible changes to the public package.

## Unreleased

### Changed

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
