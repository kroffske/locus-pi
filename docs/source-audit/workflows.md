# Source audit: workflows

Decision: `workflows` is a default-loaded, critical-risk Locus-specific runtime
extension. Saved workflow JavaScript is reviewed trusted input with full
Node.js/module access in the Pi host process; no sandbox or capability isolation
is present. The implementation is locally owned and write-from-scratch. No copied
or borrowed runtime implementation was identified for this source-audit slice.

## Local source truth

- `extensions/workflows/index.ts` registers the `workflow` tool and `/workflows`
  command. It composes target resolution, execution, status/detail rendering,
  progress, transcript and catalog owners without redefining their policies. The
  model-callable tool keeps Pi `approval: "exec"` with full-host/no-sandbox
  warning details; explicit operator `/workflows run` does not pass through that
  tool approval and adds no second Locus prompt.
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
  intents and bounded AST extraction of literal exported `meta.description`. Its
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
- `extensions/workflows/index.ts` projects static help, catalog, status/detail,
  launch errors and headless settled receipts through the shared typed operator
  block. It also owns the single `/workflows info [name]` block and chooses its
  projection: interactive TUI with custom UI awaits `WorkflowInfoViewer`, while
  RPC, print/no-UI, and TUI without custom UI retain the bounded passive block
  with an honest fallback limitation. The info viewer cannot import or run a
  workflow, mutate the editor, or write files. Separately, the TUI list awaits
  the focused catalog component's typed result, then may call `setEditorText()`
  once after custom UI completion with a compact Request +
  `$pi-workflow-authoring` skill handoff; the skill owns the action procedure.
  Back/cancel yields no editor mutation; an absent or throwing setter has an
  explicit warning and no send/run fallback.
  It bounds status/detail rows and leaves complete evidence in `result.json`.
  The existing live progress, resolver, journal, approval, and execution owners
  are not reimplemented by this presentation layer.
- `extensions/_shared/command-ui.ts` owns generic transient-key pinning and cleanup
  callbacks. The workflow extension removes completed large widget/status/transient
  presentation on the next input, registered command cleanup, or `turn_end`, then
  delegates row retention to store-owned cleanup: the newest five fully terminal
  workflow run subtrees remain available for `/ps` viewer/last/direct guidance,
  older terminal subtrees are pruned, and active, queued, or zero-row runs are not
  counted or pruned. No timer or second workflow registry is used.
- `extensions/_shared/workflow-runtime.ts` owns the DSL primitives:
  `agent`, `llm`, `parallel`, `pipeline`, `phase`, `log`, and `workflow`.
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
- `extensions/_shared/workflow-journal.ts` owns run discovery/order and
  immutable executed-snapshot reads as well as journal-to-live status mapping.
  Status/catalog consumers see only evidenced directories with a canonical UTC
  id prefix or persisted journal timestamp; legacy ids sort by that timestamp
  and worktree-only test artifacts are not surfaced as runs. Snapshot `ready`
  requires a simple run id, exact lexical run/file identity, non-symlink
  directory chain, regular non-symlink file, direct-child realpath containment,
  valid persisted target, and matching byte hash. `legacy`, `missing`,
  `unreadable`, `invalid`, and `tampered` are explicit and perform no alternative
  or current-source read. `cancelled` is a distinct terminal live state; terminal
  mapping clears active tool state so the progress panel and shared fleet agree.
- `extensions/_shared/agent-live-panel.ts` owns status markers and short event
  grammar: success only for `done`, distinct cancelled and failed variants.
- `extensions/_shared/agent-sdk-host.ts` settles the canonical SDK child row to
  `cancelled` on an abort before returning the child result; the journal mapping
  settles the workflow parent to the same state. `AgentLiveStore.patch` owns the
  shared terminal invariant for `done`/`cancelled`/`error`: remove all three live
  tool fields and freeze elapsed time once.
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
  by agent name; a missing role is an explicit failed result. Per-call
  `opts.model` is the execution override; otherwise the SDK executor receives
  the current session model. Agent-frontmatter model-role resolution is retained
  in the request capsule and live/artifact metadata rather than silently treated
  as the executor model. The bridge fails closed when the host cannot spawn a
  child session.
- `extensions/_shared/workflow-llm-bridge.ts` owns direct `llm()` model selection.
  An explicit per-call selector must resolve through `getModel`; an omitted
  selector uses `ctx.model`. Before `completeSimple` / `streamSimple`, it resolves
  request auth through `ctx.modelRegistry.getApiKeyAndHeaders(model)` and forwards
  the API key, provider/model headers, and provider environment. It does not use
  agent catalog roles and returns `ok:false` when no model or request auth resolves.
  `workflow-runtime.ts` retains the first bounded failure diagnostic on `llm_end`;
  status/detail and the final transcript fallback expose it instead of collapsing
  a zero-token provider failure to a generic workflow error.
- `extensions/workflows/examples/review/review.workflow.mjs` is a curated
  review composition, not a new runtime primitive. It accepts an opaque
  free-form request. A full `oracle` child owns target resolution and access
  proof; parallel `oracle` children independently obtain and inspect
  change-focused and whole-context evidence; an adjudicator reopens the target
  and verifies findings; a publisher creates a local review task and writes
  immutable `.tasks/<task>/artifacts/review.md` plus an all-pending
  `fix-plan.md` approval manifest only after proving `.tasks/` is ignored. The
  publisher copies adjudicated findings exactly and does not perform a second
  planning pass or write into a different reviewed repository. Agent ids,
  numbers, names, labels, options, and full prompt templates live in the
  package-owned `extensions/workflows/examples/review-family/agents.yaml`; the
  entry script imports the validating neutral family loader and therefore
  declares `identityCoverage: "entry-only"`. The loader reads only that YAML,
  while repository/forge evidence remains agent-owned. The workflow performs no
  direct Git, network, forge-specific, packet-building, or `llm()` work.
  Every stage uses schema-bearing `agent()` output and records child-session
  evidence in `result.json`. The selected catalog agent keeps its full tool
  surface under `permissionMode: "agent-defined"` and
  `workspaceMode: "project"`, so private forge access comes from the child
  session's existing tools and authentication rather than package-owned API
  code. Prompts prohibit
  source, branch, commit, push, and remote mutations during review, but prompt
  text and permission metadata are not a sandbox; Pi's tool approval remains
  the enforcement boundary. A failed parallel lane remains a typed group
  failure, while ambiguous targets, inaccessible evidence, a blocked verdict,
  or missing Markdown publication remain explicit non-success.
- `extensions/workflows/examples/review-fix/review-fix.workflow.mjs` is the curated,
  human-gated remediation exception. Its resolver accepts only findings whose
  current Markdown disposition is exactly `accepted`. Its implementer creates a
  distinct linked Git worktree at the reviewed snapshot and changes only those
  items. Its verifier rechecks the diff and writes `fix-report.md`. Prompts
  prohibit original-checkout edits, commit, push, pull-request creation, merge,
  deployment, and remote mutation. These are agent instructions plus Pi
  approvals, not a new sandbox.
- Workflow rows and the `agents` entrypoint share the versioned process-local
  live store required by Pi's per-entrypoint `jiti` loading. This makes active
  workflow children drillable and individually cancellable from the fleet.
- `extensions/workflows/AUTHORING.md` is the co-located authoring pointer.
- `docs/extensions/active/workflows.md` is the canonical workflow DSL and
  authoring contract.

## Pi 0.80.3 command and custom-UI contracts

The installed `@earendil-works/pi-coding-agent` package is version `0.80.3`.
Its local source establishes the launch guard:

- `dist/core/agent-session.js:723-750` executes registered extension commands
  immediately, including while the parent agent is streaming.
- `dist/core/agent-session.js:1001-1026` routes a streaming custom message with
  no `deliverAs` to `agent.steer()`; `triggerTurn:false` only appends without a
  turn when the session is already idle.
- `dist/core/extensions/types.d.ts:208-250` exposes `ctx.isIdle()` on every
  extension context and `waitForIdle()` on command contexts. The workflow
  command uses the synchronous idle check to fail a busy launch closed, then
  uses `waitForIdle()` after completion because the parent may start streaming
  while a long workflow is still active.
- `dist/core/agent-session.js:1813-1815` binds `ctx.isIdle()` to
  `!this.isStreaming` in the real host.
- `dist/modes/interactive/interactive-mode.js:1151-1159` binds command
  `waitForIdle()` to `session.agent.waitForIdle()` in the TUI; the RPC and
  print/JSON modes bind the same primitive in their mode adapters.
- `examples/extensions/send-user-message.ts:17-35` demonstrates the same
  fail-closed command pattern: check `ctx.isIdle()`, warn, and return before a
  message send when the agent is busy.

Its local TUI documentation establishes the browser handoff order:

- `docs/tui.md:661-684` awaits `ctx.ui.custom()` and calls
  `ctx.ui.setEditorText(result)` only after the custom component has completed.
- `extensions/workflows/catalog-viewer.ts` therefore receives only
  `done(intent)` and cannot mutate the editor. `extensions/workflows/index.ts`
  owns the optional setter call after the awaited result. This is also why
  cancel, Back, custom-UI rejection, and absent/throwing setter tests require
  zero editor mutation and zero send/run fallback.

The local shim and test harness model this routing explicitly. A busy slash-run
test proves zero workflow execution, zero `sendMessage`, and a warning. A TOCTOU
test launches idle, switches the parent to streaming before workflow completion,
proves no message is sent while busy, settles the parent, then observes exactly
one append delivery with no steer, follow-up, model turn, or raw result detail.

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
  `tests/extensions/workflows/workflow-identity-projection.test.ts`,
  `tests/shared/workflows/workflow-group-failure.test.ts`,
  `tests/extensions/workflows/workflow-catalog.test.ts`,
  `tests/extensions/workflows/workflow-catalog-viewer.test.ts`,
  `tests/extensions/workflows/review-workflow.test.ts`,
  `tests/extensions/workflows/workflow-transcript.test.ts`,
  `tests/extensions/workflows/workflows-launch-gate.test.ts`,
  `tests/extensions/workflows/workflows-progress.test.ts`, and
  `tests/integration/public-registration.test.ts` are the local regression checks for
  the current active behavior claims.

License note: this audit did not identify copied external runtime code for the
workflow extension. Existing `pi-subagents` comparison material remains reference
context for future design discussions, not an implementation dependency for this
extension.
