# Source audit: workflows

Decision: `workflows` is a default-loaded, critical-risk Locus-specific runtime
extension. Saved workflow JavaScript is reviewed trusted input with full
Node.js/module access in the Pi host process; no sandbox or capability isolation
is present. The implementation is locally owned and write-from-scratch. No copied
or borrowed runtime implementation was identified for this source-audit slice.

## Local source truth

- `extensions/workflows/index.ts` is the entrypoint. It registers the
  `workflow` tool (`workflow-tool.ts`) and the `/workflows` command
  (`command-router.ts`), and wires only the per-session state those two need —
  live progress panels, completed-run bookkeeping, the command launcher, and
  the operator handoff controller. Command routing (`command-router.ts`),
  launch-precondition target resolution (`launch-guard.ts`), transcript
  (`workflow-transcript.ts`), launcher (`workflow-command-launcher.ts`),
  handoff (`operator-handoff-controller.ts` / `operator-handoff-service.ts`),
  and catalog (`workflow-catalog.ts` / `catalog-viewer.ts`) owners keep their
  own policies; the entrypoint does not redefine them. The
  model-callable tool (`workflow-tool.ts`) keeps Pi `approval: "exec"` with full-host/no-sandbox
  warning details; explicit operator `/workflows run` does not pass through that
  tool approval and adds no second Locus prompt. Interactive command runs claim
  one stable session/project background identity and return the editor; the programmatic
  tool remains awaited/headless but registers non-exclusive control with the
  same run owner. `/workflows stop [runId|last]` (`command-router.ts`) reaches either launch origin,
  is the sole workflow operator-cancellation path, and reports `stopping` until
  terminal settlement. Native command completion (`command-completions.ts`) returns full argument strings
  for grammar-owned tokens and yields free-text tails.
- `extensions/workflows/workflow-command-launcher.ts` is the single command
  execution policy used by flat and compatibility command routes. It owns the
  current session lease, exclusive background launch, non-exclusive tool
  attachment, runner `onRunStart` binding, terminal observation, stop/shutdown,
  and the shared started/busy/stale result. `index.ts` supplies a rendering
  observer; the launcher does not define operator copy or widget layout.
- `extensions/workflows/background-run-registry.ts` owns the process-local stable
  session/project identity, a generation-scoped callback lease, abort controller,
  and terminal promise for command and tool runs. Tool control is non-exclusive
  and does not occupy the single interactive slash slot. Reload cannot claim a second run
  under the same identity until an abort-ignoring predecessor settles.
  `session_shutdown` revokes callbacks, aborts active work, and the extension
  immediately disposes its session-owned progress component, including its
  live-store listener and timer, so a late child cannot repaint or append into a
  reloaded session.
- `extensions/workflows/operator-handoff-service.ts` owns persisted handoff
  classification as actionable, nonactionable, or invalid. It revalidates the
  current target and script identity, atomically claims the source handoff,
  delegates continuation to `workflow-command-launcher.ts`, and releases the
  claim when launch is busy or stale. The adjacent controller owns only
  session-local FIFO, snooze, question collection, and mount/launch guards.
- `extensions/workflows/workflow-transcript.ts` owns the explicit command/tool
  transcript boundary. Command and tool runs buffer lifecycle without any
  active-run `sendMessage`. After completion, a command awaits `waitForIdle`,
  rechecks `isIdle`, and appends one visible digest with `triggerTurn:false` and
  no `deliverAs`; a tool puts its digest in the native final `toolResult`.
  Workflow agent lines use stable journal `agent` + `label` rather than the
  collapsible parent row's petname. Journal errors are retained only as fallback
  text for exactly one final `workflow_end` failure.
- `extensions/workflows/workflow-catalog.ts` owns the single current/history
  model over `listWorkflowCatalogTargets()`, query filtering, exact current
  source/path projection, run-specific history identity, deterministic browser
  intents and bounded AST extraction of literal exported `meta.description` and
  optional `meta.phases` (one read and one parse per row; a non-literal phase
  entry discards the whole declaration). Its
  exact-source boundary retains the selected `ResolvedWorkflowTarget`,
  revalidates it through the same first-wins resolver, and only then reads the
  file as inert full UTF-8 text. Missing, unreadable, and newly shadowed current
  selections remain distinct. History delegates to the journal's exact snapshot
  reader, re-reads before open, and returns `stale` if the selected run target,
  path, SHA, or identity coverage changed. It never consults current source.
  `[R]` is a run-history lens;
  `[P]`/`[U]`/`[PKG]` are compact labels for project, user, and package sources.
- `extensions/workflows/catalog-viewer.ts` owns the focused `/workflows list`
  cursor, current/history selection, catalog/source/identity screen transition,
  independent source and identity scroll, action focus, and width-bounded
  rendering. Catalog entries are two-line logical rows with a middle-truncated
  path that preserves its beginning and basename; compact terminals retain a
  one-line fallback, and content-aware section sizing keeps Current and History
  adjacent before padding unused height. The viewer uses terminal height minus Pi's three footer rows,
  with no 24-row cap. `i` exposes the exact current path or history run ID,
  snapshot path, and SHA; Up/Down, PageUp/PageDown, Home, and End keep that
  identity reachable even at widths 8 and 1. Current ready source exposes
  `Back`/`Start`/`Edit`/`Review`; history exposes only `Back`/`Review`. Tab changes
  action focus, a caret plus semantic warning tone marks the selected action, and
  success tone distinguishes other actions and metadata labels. Enter resolves a
  typed intent, Esc returns to the preserved catalog cursor from source, and `i`
  or Esc returns from identity to the preserved source position. Source
  highlighting uses Pi's native JavaScript highlighter inside a persistent
  top/bottom code frame. The component has no command context or editor callback
  and cannot execute, write, send, or prefill by itself. The same file owns the separate
  read-only `WorkflowInfoViewer`: it renders one immutable `OperatorBlock`, keeps
  every semantic line reachable with Up/Down, PgUp/PgDn, and Home/End at 146,
  80, and 48 columns, and closes with Esc/q.
- `extensions/workflows/run-viewer.ts` owns the read-only persisted evidence
  browser used by `/workflows dashboard` and interactive status commands. It
  discovers accepted run ids through the journal owner, groups journal and
  indexed artifacts by phase, and exposes run → stage → evidence → content
  navigation. It reads no live agent/session state. Before rendering an indexed
  artifact it reopens the record through the artifact owner and verifies digest,
  relative path, size, and media type; changed, missing, malformed, oversized,
  or tampered evidence remains an explicit unavailable state. If custom UI
  creation throws, command routing immediately returns the bounded static block
  instead of routing back into the same viewer. RPC, print/no-UI, and TUI hosts
  without custom UI keep that projection.
- `extensions/workflows/command-router.ts` projects static help, catalog, status/detail
  (`run-evidence.ts`),
  launch errors and headless settled receipts through the shared typed operator
  block (`operator-ui.ts`). It also owns the single `/workflows info [name]` block and chooses its
  projection: interactive TUI with custom UI awaits `WorkflowInfoViewer`, while
  RPC, print/no-UI, and TUI without custom UI retain the bounded passive block
  with an honest fallback limitation. The info viewer cannot import or run a
  workflow, mutate the editor, or write files. Separately, the TUI list awaits
  the focused catalog component's typed result, then may call `setEditorText()`
  once after custom UI completion. `Start` prefills the direct
  `/workflows run <resolved-name>` command, so submitting it reaches the runtime
  without a model planning/authoring turn. `Edit` and `Review` keep the compact
  Request + `Agent: workflow-author` handoff because those actions require source
  work; that agent is bundled in `.agents/agents/` and installs with the package,
  so the pointer resolves through normal agent discovery. Historical rows remain
  review-only.
  Back/cancel yields no editor mutation; an absent or throwing setter has an
  explicit warning and no send/run fallback.
  Every custom workflow browser/viewer uses the shared inline interaction
  contract (`overlay:false`), so it replaces the editor area instead of covering
  scrollback and restores editor focus on close.
  It bounds status/detail rows and leaves complete evidence in `result.json`.
  The existing live progress, resolver, journal, approval, and execution owners
  are not reimplemented by this presentation layer.
- `extensions/_shared/command-ui.ts` owns generic transient-key pinning and cleanup
  callbacks. The workflow extension removes completed large widget/status/transient
  presentation on the next input, registered command cleanup, or `turn_end`, then
  delegates row retention to store-owned cleanup: the newest five fully terminal
  workflow run subtrees remain available for `/ps` viewer/last/direct guidance,
  older terminal subtrees are pruned, and active, queued, or zero-row runs are not
  counted or pruned. No timer or duplicate workflow registry is used.
- `extensions/workflows/progress-widget.ts` owns the workflow-specific compact
  stage projection: declared/reached/current labels in declaration order, one
  active shared agent row, non-selectable parallel headings, and round `rN`
  markers. `/ps` remains the shared fleet/viewer entrypoint rather than a second
  workflow renderer; the workflow event adapter verifies replay answer artifacts
  before it projects their text into the generic viewer row.
- `extensions/_shared/workflow-runtime.ts` owns the DSL primitives:
  `agent`, `publishArtifact`, `consumeTextArtifact`,
  `awaitOperator`, `promptFile`, `workspace`,
  `projectRoot`, `parallel`, `pipeline`, `phase`, `log`, `now`, and `random`.
  `agent()` is the
  single model-calling primitive; the former direct-completion node `llm()` and its
  pi-ai bridge were removed, together with the `llm_start`/`llm_end`/`llm_delta`
  journal kinds and the synthetic `llm` live row.
  It also owns the fail-closed group barrier. Ordinary thrown work and direct
  `ok:false` / `status:failed|blocked|cancelled` returns become ordered failed
  slots; scheduled siblings settle before one `WorkflowGroupFailureError` is
  thrown. `WorkflowInvocationCapError` remains a separate hard run-level error.
  Discriminated slots preserve the difference between fulfilled `null` and a
  failed position; pipeline failures carry item and stage evidence.
  Schema-bearing calls also return the local `WorkflowSchemaValidation` value
  object. It distinguishes valid recovery from exhausted parser/validator
  mismatch, records actual fresh attempts, and mirrors the outcome to terminal
  journal lines; it is protocol accounting, not a domain-quality verdict.
- `extensions/_shared/workflow-artifacts.ts` owns the canonical per-run artifact
  store at `.locus/runtime/workflows/<runId>/artifacts/index.json`. Every record
  binds `{runId, artifactId, name, sha256}` to media type, size, relative path,
  stage, provenance, and optional source lineage. It assigns confined
  answer/transcript/result, published, and consumed-input destinations; verifies
  the single-owner index, safe components, regular-file/symlink confinement,
  transcript identity, byte limits, and digests; and exposes side-effect-free
  readers for viewers. `publishArtifact()` appends deterministic text.
  `consumeTextArtifact()` accepts only a complete reference from a successful
  prior run's terminal artifact projection, verifies and copies the source
  bytes, and records the original ref. An index-only record is not consumable.
  The confinement check starts at the physical project root and rejects a
  symlink in any `.locus/runtime/workflows/<runId>` ancestor before read, write,
  or consume. It also returns the verified source workflow target, source
  artifact kind/stage, structured terminal result, and terminal artifact refs so
  compositions can bind a handoff to the producer's result rather than mutable
  index metadata. Self-reference and partial/tampered refs fail closed.
- `extensions/_shared/workflow-runner.ts` owns final disposition after every
  evidence owner has settled: controlling abort, failure, declared operator
  handoff, then completion. It persists closed cancellation reasons and a
  runtime cancellation journal line, so trusted script catches cannot turn an
  aborted run green. It also projects the newest 20 answer and
  workflow-published refs into the persisted run envelope, with an explicit
  omitted count. `extensions/workflows/workflow-tool.ts` copies the same bounded list
  into native workflow tool details and text so the calling model can pass a
  complete ref to a later run without inventing an artifact id. The canonical
  full inventory remains the per-run artifact index.
- `extensions/_shared/workflow-worktree.ts` owns disposable linked-worktree
  creation and the retained workflow workspace manager: detached worktrees at
  exact refs under the run directory, verification of the original checkout and
  of each workspace's HEAD and realpath on every resolve, and workspace
  evidence for the run envelope.
- `extensions/_shared/workflow-journal.ts` owns run discovery/order and
  immutable executed-snapshot reads as well as journal-to-live status mapping.
  Status/catalog consumers see only evidenced directories with a canonical UTC
  id prefix or persisted journal timestamp; legacy ids sort by that timestamp
  and worktree-only test artifacts are not surfaced as runs. Snapshot `ready`
  requires a simple run id, exact lexical run/file identity, non-symlink
  directory chain, regular non-symlink file, direct-child realpath containment,
  valid persisted target, and matching byte hash. `legacy`, `missing`,
  `unreadable`, `invalid`, and `tampered` are explicit and perform no alternative
  or current-source read. Malformed NDJSON rows and structurally invalid journal
  objects remain explicit diagnostics rather than disappearing from the read
  model. Per-kind field allowlists and required fields prevent an empty
  `agent_end` or a cross-kind field from becoming completion evidence.
  Persisted summaries consume the strict shared disposition projector; only an
  absent legacy disposition falls back to `ok`, while malformed future values
  remain `unknown`. `cancelled` is a distinct terminal live state; terminal
  mapping clears active tool state so the progress panel and shared fleet agree.
- `extensions/_shared/agent-live-panel.ts` owns status markers and short event
  grammar: success only for `done`, distinct cancelled and failed variants.
- `extensions/_shared/fleet-menu.ts` uses explicit `workflowRunId` provenance
  to keep workflow rows inspectable while suppressing both the `x stop` hint and
  handler. Escape is consumed without host abort while workflow work is active;
  `/workflows stop` remains the only workflow cancellation entrypoint.
- `extensions/_shared/agent-sdk-host.ts` settles the canonical SDK child row to
  `cancelled` on an abort before returning the child result; the journal mapping
  settles the workflow parent to the same state. `AgentLiveStore.patch` owns the
  shared terminal invariant for `done`/`cancelled`/`error`: remove all three live
  tool fields and freeze elapsed time once. Turn cancellation waits only a
  bounded interval for the SDK `abort()` acknowledgement, then continues trace,
  result, and disposal work even if that promise never settles.
- `extensions/_shared/agent-read-only-policy.ts` owns the optional
  `repository_check` capability for read-only children. The workflow bridge
  freezes the exact package script map before any child can write. The model can
  name only a baseline script while the entire current map still equals that
  baseline; additions, removals, changes, and lifecycle hooks all fail closed.
  The host fixes the package-manager argv,
  cwd, timeout, output bound, and cleanup, overlays current tracked/untracked
  source into a disposable external Git worktree, recursively materializes
  initialized gitlink source without Git administrative metadata, borrows the
  Git-ignored `node_modules`/`.venv` roots by symlink so a declared check can
  resolve its own toolchain, unlinks those borrowed roots before removing the
  snapshot, and never
  executes in the operator checkout. Package scripts remain trusted
  operator-owned code; this is checkout isolation, not an OS/network sandbox,
  and a script that writes inside a borrowed dependency root reaches the
  project's real install tree.
- `extensions/_shared/workflow-script-identity.ts` owns versioned exact-entry
  identity, static source-policy analysis, read-only snapshots and final snapshot
  verification. Default `self-contained-static` permits only direct static
  `node:` imports/re-exports and executes the snapshot. Literal
  `meta.identityCoverage: "entry-only"` permits unbound local/package/dynamic/
  source-anchored behavior while recording the downgrade and dependency evidence.
  The AST policy covers direct declared forms, not `createRequire` aliases,
  eval-generated imports or arbitrary host-code loading. Only the old unversioned
  identity reads as `entry-only-legacy`; unknown/inconsistent schemas fail closed.
  This is point-in-time source accounting, not a sandbox or atomic race guarantee.
  The same parse also owns replay-safety: `assessWorkflowReplaySafety()` reports
  `unproven` when the source names direct clock/randomness syntax. That verdict
  is machine-derived on purpose — there is no author-asserted `meta` field,
  because an assertion would fail open. It reads syntax, not behavior, so an
  aliased root or an imported module is outside it.
- `extensions/_shared/workflow-replay.ts` owns the recorded-call store behind
  `--resume`: the `replay.ndjson` record inside the existing run directory, the
  sha-256 call key, the per-kind read cursors, and the single divergence latch
  that makes replay a strict prefix. Every unresolved lookup is an explicit miss
  the caller answers by running the real child; no path in the module can produce
  an answer that was not recorded by an earlier execution of the identical
  request. Records are kept out of `journal.ndjson` deliberately: the journal
  carries the `replayed` marker only, so bounded status/digest surfaces never
  receive unbounded child text. Write failures are swallowed like the journal
  sink's — they cost a future resume, never the current run.
- `extensions/_shared/workflow-runner.ts` owns target resolution and load order.
  It imports the snapshot for strict coverage or the hash-keyed source URL for
  explicit entry-only coverage, with a per-run cache key and pre/post byte checks. At resolution time,
  explicit and saved-name project targets pass lexical
  plus canonical `realpath` containment; observed external symlinks fail closed and internal
  symlinks retain their lexical path after the physical target is verified in-project.
  The check and later Node import are not atomic, so concurrent target replacement
  remains inside the trusted-author assumption rather than a sandbox guarantee.
  The native main-context loader permits Node built-ins and explicitly downgraded
  installed/local modules, so reviewed scripts retain host filesystem,
  subprocess, network and other module capabilities. `dsl`, worktrees and
  approval metadata do not narrow that power; this is not a sandbox.
- `extensions/_shared/workflow-runner.ts` also owns the unhandled group-failure
  projection. It removes potentially non-JSON-safe branch values, persists a
  typed `workflow_group_failure` result envelope, and keeps the outer run
  `ok:false` with the group error text and failed journal/status evidence.
- `extensions/workflows/manifest.json` therefore declares `risk: critical`,
  conservative unrestricted host capability strings, and the actual lifecycle
  hooks `input` plus `turn_end`. `browser: true` records that trusted imported
  modules may drive browser-capable code when present; it does not expose a new DSL
  browser primitive.
- `extensions/_shared/workflow-result.ts` owns JSON-safe result normalization,
  semantic main projection, bounded status detail, and honest `result.json`
  persistence diagnostics. A diagnostic sentinel for a non-JSON-safe script
  result forces the outer envelope to `ok:false`. Failure to persist the mandatory
  envelope forces the returned run to `ok:false`, retains typed persistence
  evidence, and writes a terminal runtime error to the journal. After detach,
  top-level boolean `result.ok:false` is the explicit domain-failure signal,
  while top-level `result.partial:true` is semantic non-success. A missing or
  non-boolean top-level `result.ok`, and any nested `ok:false`, preserve legacy
  execution-success semantics unless top-level `result.partial:true`. This lets
  a trusted script deliberately catch only `WORKFLOW_GROUP_FAILURE` and expose
  sanitized partial evidence without any surface relabeling the run as completed.
  The same owner formats semantic failure summary and stable unresolved row ids
  for transcript, tool/command result block, and live progress. It is local
  boundary code, not borrowed behavior.
- `extensions/_shared/workflow-agent-bridge.ts` routes workflow `agent()` calls
  through the same agent boundary and host SDK child-session path used by the
  `task` tool. Catalog definitions resolve project → user → bundled, first-wins
  by agent name; a missing role is an explicit failed result. The executor model
  is `per-call opts.model` → `per-call opts.modelRole` → the agent's frontmatter
  tier → `ctx.model`, resolved through `ctx.modelRegistry.find`
  (`workflow-model-resolve.ts`) before any child is spawned. A CONCRETE
  `provider/id` selector that the registry cannot resolve ends the call with a
  named failed result and zero child sessions; a declared ROLE that no
  model-roles layer assigns degrades to `ctx.model` and records
  `modelRoleFallback` on `agent_end`, in the run-result artifact and in the run
  report; a ROLE whose assignment exists but does not parse as a selector fails
  the call by name rather than degrading, because a typo is a config error and
  not an unassigned tier. `modelRoleResolution` continues to travel in the request capsule and
  live/artifact metadata. The model the child SESSION reports is read back after
  `createSession` and carried as `executedModel`; a readback that contradicts the
  resolved request fails the call with both values quoted. The bridge fails
  closed when the host cannot spawn a child session.
- No direct-model bridge exists. Every model call in a workflow is a child agent
  session through `workflow-agent-bridge.ts`. `workflow-runtime.ts` retains the
  latest bounded journal `error` message; status/detail and the final transcript
  fallback expose it instead of collapsing a failed run to a generic workflow
  error. The run-level token/cost budget is summed from `agent_end` `usage`.
- `extensions/workflows/examples/review/review.workflow.mjs` is a curated
  review composition, not a new runtime primitive. A fresh semantic string goes
  first to a shaped read-only clarifier. It either continues or publishes exact
  intent/question refs, declares a generic structured operator handoff, and
  stops. The workflow host then projects those questions directly and supplies
  the deterministic non-empty answer text while continuation verifies and
  copies both refs before entry code;
  the workflow validates terminal provenance and publishes those answers. Both
  fresh-continue and continuation paths then run five
  sequential read-only sessions for scope, inventory, units, questions, and
  independent verification. Deterministic entry code requires unique inventory
  `C<n>` headings, exact-once unit assignment, exact ledger grammar with the
  assigned `U<n>` preserved in questions and final review, and bounded text at
  every handoff. Runtime `publishArtifact()` owns every durable
  Markdown handoff and persists the verifier's exact text as `review.md`; there
  is no publisher child or task-local report. Complete stage prompts live beside
  the entry under `resources/`; runtime resolves, confines, snapshots, and
  hashes them. Repository/forge evidence remains child-session-owned. The
  review entry imports nothing and retains `self-contained-static` identity.
- `extensions/workflows/examples/plan/plan.workflow.mjs` and
  `extensions/workflows/examples/plan-implement/plan-implement.workflow.mjs` are
  the second curated pair and add no runtime primitive. `plan` is read-only end to
  end and declares its three participants in one frozen `PLAN_AGENTS` roster:
  `scout` maps the repository once, then a `planner`/`critic` pair loops on a
  declared `accept`/`revise` enum with the critic's exact defects forwarded to the
  next round. It never pauses for an operator; an undecided choice is recorded by
  the planner under `## Assumptions` and judged by the critic, so an unstated
  assumption is a defect and a stated one is not. Reaching the round cap without
  an acceptance returns `ok:false`, which is also what keeps an unaccepted draft
  out of implementation. `plan-implement` accepts semantic text plus host
  continuation containing one complete `plan.md` ref, and reads the bytes the host
  already verified and copied — at any length — rather than re-deriving that proof
  or capping a plan somebody has already accepted. Deterministic code parses `### S<n>` blocks, a no-tool
  selector chooses the steps, the plan's own order is restored, and one
  write-capable session owns each step in the launch checkout. A read-only
  checker and a fresh reporter
  follow; a failed writer skips the remaining steps and the run returns
  `partial: true`. Both entries import nothing and retain
  `self-contained-static` identity.
- `extensions/workflows/examples/review-fix/review-fix.workflow.mjs` is the
  curated remediation exception. It accepts only semantic text plus host
  continuation containing one complete immutable `review.md` ref. The artifact owner
  verifies the successful source run, full reference, and digest before copying
  bytes into the new run; entry code additionally requires the bytes to equal
  the source terminal result, the exact ref to be its last projected output, and
  the final `verify-review` answer to come from the curated Package workflow named `review`.
  A no-tool read-only selector returns 1–20 `{id,note,dependsOn}` units through
  the shaped-agent boundary. Deterministic entry code then parses complete
  `### F<n>` blocks inside `## Findings`, rejects invalid ids, notes, edges and
  cycles, and computes stable topological order before writers. A read-only scope
  resolver sees only selected blocks. Exactly one sequential writer owns each
  selected finding in the launch checkout. Every remediation input/handoff has a fixed character
  bound. A separate
  host-enforced read-only child collects full-diff evidence and runs only
  baseline package scripts through the isolated `repository_check` tool while
  the complete pre-writer script map remains unchanged; added/removed/modified
  commands or lifecycle hooks are rejected before execution. A fresh
  read-only child reopens every original finding, affected dependency, and
  regression risk. `agent({artifact})` names
  the automatic answers `finding-plan.json`, `scope.md`, `worker-F<n>.md`, `check-evidence.md`, and
  `re-review.md`; the last is also the workflow result. There is no imported
  input helper, unit planner, publisher, task-local output, or `fix-report.md`,
  so the entry keeps `self-contained-static` identity. Prompts prohibit commit,
  push, pull-request creation, merge, deployment, remote mutation, and
  discarding unrelated uncommitted work. These remain agent instructions plus
  Pi approvals, not a new sandbox.
- `.pi/workflows/locus-plan.workflow.mjs` and
  `.pi/workflows/test-code.workflow.mjs` are ignored project-local dogfood for
  split-run planning and independent testcase design, implementation/execution,
  and failure attribution. They are not tracked source, Package registry rows,
  or public npm files and therefore do not widen this audited package surface.
- Workflow rows and the `agents` entrypoint share the versioned process-local
  live store required by Pi's per-entrypoint `jiti` loading. This makes active
  workflow children drillable and individually cancellable from the fleet.
- `extensions/workflows/AUTHORING.md` is the co-located authoring pointer.
- `docs/extensions/active/workflows.md` is the canonical workflow DSL and
  authoring contract.

## Pi 0.82.0 command, lifecycle, and custom-UI contracts

The installed `@earendil-works/pi-coding-agent` package is version `0.82.0`.
Its local source establishes the launch guard:

- `dist/core/agent-session.js:785-932` executes registered extension commands
  immediately, including while the parent agent is streaming.
- `dist/core/agent-session.js:1058-1090` routes a streaming custom message with
  no `deliverAs` to `agent.steer()`; `triggerTurn:false` only appends without a
  turn when the session is already idle.
- `dist/core/extensions/types.d.ts:214-252` exposes `ctx.isIdle()` on every
  extension context and `waitForIdle()` on command contexts. The workflow
  command uses the synchronous idle check to fail a busy launch closed, then
  uses `waitForIdle()` after completion because the parent may start streaming
  while a long workflow is still active.
- `dist/core/agent-session.js:587-594` binds `ctx.isIdle()` to the complete
  agent-run state, including post-turn continuation.
- `dist/modes/interactive/interactive-mode.js:1212-1220` binds command
  `waitForIdle()` to `session.agent.waitForIdle()` in the TUI; the RPC and
  print/JSON modes bind the same primitive in their mode adapters.
- `dist/core/agent-session.js:305-322` and
  `dist/core/extensions/types.d.ts:540,866` expose `agent_settled` only after
  the full agent run is inactive. Workflow questions
  triggered by a tool run use that terminal event rather than `turn_end`, which
  can occur before a retry, compaction retry, or queued continuation has
  finished.
- `examples/extensions/send-user-message.ts:17-35` demonstrates the same
  fail-closed command pattern: check `ctx.isIdle()`, warn, and return before a
  message send when the agent is busy.

Its local TUI documentation establishes the browser handoff order:

- `docs/tui.md:661-684` awaits `ctx.ui.custom()` and calls
  `ctx.ui.setEditorText(result)` only after the custom component has completed.
- `extensions/workflows/catalog-viewer.ts` therefore receives only
  `done(intent)` and cannot mutate the editor. `extensions/workflows/command-router.ts`
  owns the optional setter call after the awaited result. This is also why
  cancel, Back, custom-UI rejection, and absent/throwing setter tests require
  zero editor mutation and zero send/run fallback.

The local shim and test harness model this routing explicitly. A busy slash-run
test proves zero workflow execution, zero `sendMessage`, and a warning. A TOCTOU
test launches idle, switches the parent to streaming before workflow completion,
proves no message is sent while busy, settles the parent, then observes exactly
one append delivery with no steer, follow-up, model turn, or raw result detail.

Actionable workflow handoffs add a strict runtime-owned envelope and a
source-adjacent atomic claim while leaving `result.json` immutable. The direct
question queue reads only validated self-contained-static handoffs, rechecks
artifact digests and target/script identity before continuation, and serializes
all Locus-owned custom UI through the shared operator-interaction owner. TUI
uses inline select/text editing; RPC uses native bidirectional UI requests;
print/JSON accepts only explicit `--answer` input. Pi provides no global lock for
third-party extensions, so bare `/workflows` is the documented recovery path.

First-class `/workflow-run`, `/workflow-stop`, `/workflow-list`,
`/workflow-info`, `/workflow-status`, and `/workflow-continue` registrations
exist for native slash filtering and Tab selection. They route through the same
handlers as compatibility `/workflows <subcommand>` forms; no duplicate launcher
or cancellation owner exists.

## Workflow-author boundary

The live command contributes bounded activity state as owner `workflow.run` to
the shared `status:locus` registry. It does not create a private `workflows`
footer key. The live widget remains domain-owned and below the editor; static
results use the shared typed presentation kit.

`.agents/agents/workflow-author.md` is a bundled catalog-agent helper for
authoring saved `.pi/workflows/<name>.workflow.mjs` files. It is not added to
`package.json#pi.extensions`, and it does not create a separate workflow runtime
surface. The active default package surface remains the `workflows` extension at
`./extensions/workflows/index.ts`.

## Review basis

- `extensions/workflows/manifest.json` records the active command/tool surfaces,
  shared/direct hooks, conservative trusted-host permissions, critical risk,
  tests, and this source-audit path. These fields describe capability; they do not
  enforce it.
- `package.json#pi.extensions` is the source truth for default-loaded package
  entrypoints.
- `tests/shared/workflows/workflow-script-identity.test.ts`,
  `tests/shared/workflows/workflow-run-snapshot.test.ts`,
  `tests/shared/workflows/workflow-handoff.test.ts`,
  `tests/extensions/workflows/workflow-handoff-integration.test.ts`,
  `tests/extensions/workflows/workflow-identity-projection.test.ts`,
  `tests/extensions/workflows/workflow-operator-handoff-controller.test.ts`,
  `tests/extensions/workflows/workflow-operator-handoff-service.test.ts`,
  `tests/extensions/workflows/workflow-command-launcher.test.ts`,
  `tests/shared/workflows/workflow-group-failure.test.ts`,
  `tests/extensions/workflows/workflow-catalog.test.ts`,
  `tests/extensions/workflows/workflow-catalog-viewer.test.ts`,
  `tests/extensions/workflows/review-workflow.test.ts`,
  `tests/extensions/workflows/workflow-transcript.test.ts`,
  `tests/extensions/workflows/workflows-launch-gate.test.ts`,
  `tests/extensions/workflows/workflows-progress.test.ts`,
  `tests/shared/workflows/workflow-agent-schema.test.ts`,
  `tests/shared/workflows/workflow-replay.test.ts`, and
  `tests/integration/public-registration.test.ts` are the local regression checks for
  the current active behavior claims.

License note: this audit did not identify copied external runtime code for the
workflow extension. Existing `pi-subagents` comparison material remains reference
context for future design discussions, not an implementation dependency for this
extension.
