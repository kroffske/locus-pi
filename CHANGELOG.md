# Changelog

This file records user-visible changes to the public package.

## [Unreleased]

## [0.4.0] - 2026-08-20

### Changed

- **Fresh workflow workspaces now stay under `.locus-pi/plans/` by default.**
  Every workflow, including `post-code-review`, receives a unique
  `.locus-pi/plans/<generated-run-name>` workspace. Operators no longer need a
  top-level `tmp/` directory or a manual `--output-dir` for a fresh review.
  `--run-name <name>` selects `.locus-pi/plans/<name>` for any workflow.
  Explicit confined output directories remain supported. Resume continues to
  reuse the recorded source workspace.

### Added

- **Manual `task/draft` intent capture and unique task planning workspaces.**
  The group-only `task` namespace now exposes `task/draft` before the existing
  `task/plan`, `task/implement-plan-template`, and `task/substep` stages. One reconnaissance agent records only
  request-relevant project facts and decides whether clarification is material.
  The drafting agent receives live questions only on that branch, is instructed
  to group no more than three questions, writes `draft.md`, and stops
  before planning. `task/plan` reads that saved draft when the operator starts
  it on the same workspace. Fresh `task/draft`, `task/plan`,
  `task/implement-plan-template`, and `task/substep` runs now receive distinct
  `.locus-pi/plans/<generated-run-name>` directories. `--run-name <name>` reuses
  `.locus-pi/plans/<name>` across the manual stages, and each completed stage
  prints the next command with that name. Confined absolute `--output-dir`
  paths and `./` paths are also accepted. Task resume reuses its recorded
  workspace and refuses a conflicting path. New run evidence, workflow state,
  and Fusion configuration now live directly under `.locus-pi/`; new writes no
  longer use `.pi/locus-pi/`, and old local artifacts are not migrated.

- **One machine-owned source for the two public catalogs — `npm run
build:catalogs`, verified by `npm run check:generated`.** The extensions
  `package.json#pi.extensions` activates and the workflow names
  `extensions/workflows/examples/` resolves were transcribed by hand into
  `README.md`, `docs/extensions.md`, `docs/workflows.md` and two contract
  tests; every copy could drift alone, and a published namespace count that
  disagreed with the directory was exactly that. Both catalogs are now resolved
  once — from the manifest set the manifest gate validates, and from the same
  static workflow discovery the registry itself uses — and written to the
  checked-in `dist/public-catalogs.json` and into fenced
  `<!-- locus:extensions:… -->` / `<!-- locus:workflows:… -->` regions of the
  published pages, counts included. `check:generated` sits between
  `check:links` and `check:fast` in `npm run check`, so adding or removing an
  entrypoint or a packaged workflow without regenerating fails the gate with
  the command that fixes it. The generator never imports a workflow module.

- **A deterministic internal-link gate over published documentation — `npm run
check:links`.** Every relative link and heading anchor in published Markdown is
  resolved against the file set that actually publishes it: `package.json#files`
  for the npm tarball, `public-repository-files.txt` for the public repository.
  Documentation is read from inside one of those, where the rest of the
  repository does not exist, so a link that resolves in a checkout and not in an
  install was previously dead with nothing to catch it. `http(s)` links stay out
  of scope on purpose — reaching them needs the network, which no offline gate
  can own. The parser is `scripts/markdown-links.ts`, shared with the
  package-boundary test that applies the same rule to a real `npm pack`.

- **Run-level no-operator mode — `/workflows run <name> --no-operator`, tool
  field `noOperator`.** One launch option turns the "shipped workflows do not
  ask" convention into a runtime guarantee for unattended callers: under the
  mode, ANY request for operator input fails closed with a named reason
  instead of parking the run. `dsl.awaitOperator(...)` fails the run at the
  call site (`Operator input requested but forbidden for this run
(no-operator mode): <reason>`) with no pause envelope, while artifacts
  published before the refusal stay on disk; an `agent({ ask: true })` stage
  is refused before any child is spawned with the closed
  `failureCause: "ask-unavailable"`. The journal opens with
  `[workflow:no-operator] operator input is forbidden for this run`; saved
  children inherit the mode through run coordination and cannot unset it.
  No auto-answer exists under the mode.

- **Headless launches (`print`/`json`) turn the no-operator mode on by
  default, with `--operator` as the opt-out.** A one-shot host has no operator
  to reach, so a request for human input there could only park the run until
  the turn was disposed: what looked like a safe convention ("shipped
  workflows do not ask") was all that kept an unattended pipeline from
  hanging on someone else's workflow. Both launch surfaces now default
  `noOperator` to on in those modes, and the run journal says why —
  `[workflow:no-operator] operator input is forbidden for this run (headless
launch: no operator can be reached)` — so a refusal is explicable to a caller
  who typed no flag. The designed `awaitOperator` split-run pause is not
  removed: `--operator` (tool field `noOperator: false`) restores it inside a
  headless launch, including for a `--resume` continuation that gates again.
  Interactive hosts (`tui`, `rpc`) are unchanged and stay opt-in, explicit
  flags beat the default in both directions, and the runner itself never
  infers the mode — an embedder opts in for its own run.

- **Live operator questions — `agent({ ask: true })`.** A stage may let its
  child ask the operator clarifying questions through the injected
  `workflow_ask` tool: the question renders in the parent session, the answer
  returns as the tool result, and the same child continues. Esc returns an
  "operator declined" text answer; concurrent asking children queue FIFO; the
  per-call `timeoutMs` fuse pauses while the operator is thinking; each
  answered call writes an `operator-ask-<n>.json` evidence artifact and a
  diagnostics line; the replay key records the declaration. With no operator
  UI (`print`/`json`, unattended) the call fails closed with the new
  `failureCause: "ask-unavailable"` — never a model-visible refusal sentence,
  never an auto-selected option. Curated Package workflows remain no-ask by
  construction. (Owner decision, direction log 2026-08-19.)

### Changed

- **The security gate no longer ships a permission grader that graded
  nothing.** `requirePermission` and its `PermissionManifest` shape had no
  caller anywhere in the package: the gate classifies tool calls and audits
  them, but never checked a capability against a manifest, so the function
  read as an enforcement path while enforcing nothing — the most expensive
  kind of dead code, because it invites trust. An extension manifest's
  `permissions` field keeps exactly the meaning the schema and
  `docs/extensions.md` already give it: a review declaration that grants no
  capability and sandboxes nothing. `isPathAllowed` and its `isWithin` helper
  existed only for the grader and leave with it; `SECRET_PATH_PATTERNS` and
  `isCommandAllowed` stay, because tool-call classification reads them.

- **Both doctors now describe the installed package instead of the project's
  migration history.** `/devext doctor` read a hand-maintained table of
  thirty-one rows that had drifted away from what ships: it never listed
  `status-line`, one of the eleven entrypoints `package.json#pi.extensions`
  activates, and it still published deleted demos, disabled experiments and
  backlog counters (`omp`, `redesign`, `split`, `fixtures`, `deleted`) as if they
  were evidence about an installation. `npx @kroffske/locus-pi doctor` answered
  the same question from a different source — the declared entrypoints and the
  files on disk — so the two disagreed. Both now read one published module,
  `extensions/devext-doctor/package-inventory.mjs`, which resolves the declared
  entrypoints at command time and reports, per entrypoint, whether it and its
  manifest are present plus the `risk` and `ownership` that manifest declares.
  Activating a twelfth extension changes both diagnostics with no edit to either
  of them. A missing file or an unreadable manifest is now a stated problem and a
  non-zero exit rather than a silent omission or a stack trace; the manifest
  contract itself stays owned by `npm run check:manifests`.

- **`npm run check` is now the one canonical gate, and `npm run check:fast` is the
  inner loop.** `check` runs `check:fast` — manifests, layers, workflow source
  shape, types, Pi host coherence, tests, source audit — and then the
  repository-wide checks that used to be reachable only through `check:push` or a
  separate CI step: `format:check` (`prettier --check`, never `--write`),
  `check:links`, `check:repository`, and `check:release`. It is deterministic,
  offline, and read-only, so a green `check` locally and a green CI now mean the
  same thing. `check:push` is `check` plus the dry-run pack contract, and CI runs
  one `npm run check` step instead of repeating the repository and release gates
  after it. Only what needs the network or the runner environment stays outside:
  the dependency audit, the extension doctor, the Pi peer version, and the pack
  candidate.

- **The stock `ask` tool is excluded from every workflow child.** A headless
  child received its no-UI refusal as model-visible text — the recorded
  fabrication path — and its option timeout auto-selected an answer on the
  operator's behalf. Workflow children now never see the stock tool; live
  questions travel only through `workflow_ask` on stages that declared
  `ask: true`.

- **Pi compatibility is now an open-ended minimum contract instead of a `0.83.x` ceiling.** The four Pi peer dependencies accept `>=0.83.0`, while development and CI continue to pin one exact, jointly updated Pi version. `npm run sync:pi-host` updates all four exact development packages from the selected CLI, `npm run check:pi-host` verifies the installed CLI and SDK packages before the suite, and selective-loading coverage runs through that installed host contract without hard-coding its version.

- **Package contract tests now follow their owners.** The former mixed `public-registration` integration file is split across package metadata, runtime registration, extension-agent catalog, workflow catalog, and documentation-reference contracts. A new host contract verifies full and selective package loading through Pi's package/resource loader.

- **The redundant documentation index was removed.** The root README now links directly to the four cross-cutting guides, while getting-started documents selective loading and mixed-provider configuration.

- **Extension manifests are now a validated contract, and six inert fields were removed from
  them.** `npm run check` runs the new `npm run check:manifests`, which loads exactly the
  manifests `package.json#pi.extensions` names, validates them against
  `extension-manifest.schema.json` with `additionalProperties: false`, and enforces unique ids,
  resolvable `docsPath` and `tests` paths, and a bundled agent profile behind every
  `agent.name`. Published manifests therefore no longer carry `name`, `version`,
  `defaultEnabled`, `behaviorStatus`, `tier`, or `sourceMode`: nothing read them, the npm
  package version owns versioning and `package.json#pi.extensions` owns activation. Enum values
  no shipped extension used — `omp-owned-to-import`, `redesign-later`, `split-required`,
  `no-current-owner`, `rewrite-first`, `fork-after-audit`, `wrapper-first`, and the unreviewed
  and blocked review states — were dropped, and `status-line` was normalized onto the same
  values as the other ten instead of remaining an unvalidated exception.

- **Extension manifests now declare the hooks the runtime actually registers.** Six extensions under-declared their `input` hook, and `agents` additionally omitted `session_shutdown`, so a reader of the published manifest or of the `docs/extensions.md` reference table saw fewer hooks than the extension installs. Both surfaces now match live registration.

- **The task namespace hands work between stages through files, and planning is
  decomposed for a weak model.** `task/plan` is now a no-ask pipeline: one
  scope agent freezes `request.md`/`scope.md`, one context agent writes
  `context.md`, three parallel analysts write `analysis/*.md`, one compose
  agent writes `plan.md` plus one `step-<n>.md` file per step (no `steps.md`),
  three parallel reviewers write `reviews/*.md`, one bounded correction
  replaces the plan once, and a final verifier plus runtime choice publish
  `plan.md` — or fail closed publishing `planning-blocker.md`. The run never
  waits for an operator: unknowns become explicit assumptions and
  pre-implementation prerequisites, so automated callers always reach a
  terminal artifact. `task/substep` now takes one selector and executes only
  the matching saved step. The owner may edit `plan.md` and `step-<n>.md` after
  planning, and both rendering and one-step recovery deliberately read the
  files on disk as the contract.

- **Approved-plan rendering and step execution now have distinct names.**
  `task/implement-plan-template` replaces the overlapping `task-via-script`
  route. It no longer replans: one scripting agent reads the already approved
  `plan.md` and `step-<n>.md` files and renders
  `implement-plan.workflow.mjs` from the fixed template, one literal node per
  step plus a summary node. Each step returns a declared completed/blocked
  choice, so a blocked history fails the workflow before the next node starts.
  `task/substep` replaces the ambiguous
  `task/implement` name and executes exactly one selected step. The generated
  file remains unregistered, resolves only by explicit path, and is never run
  by the renderer. The Package registry count stays unchanged.

- **Public documentation is now organized for external readers.** Cross-cutting guides are limited to `docs/`, extension manuals live beside their source as `extensions/<name>/README.md`, and historical ADR, PRD, milestone, and source-audit working notes are excluded from the public repository and npm documentation surface.

- **Workflow Creator is now installed with the Package.** The new
  `workflow-creator` namespace runs three source-bound children in order:
  `design` writes and independently reviews the target workflow architecture,
  `svg` draws and reviews its self-contained graph, and `build` creates and
  rechecks only the declared source files. Each child permits at most one
  complete correction and fails closed on a second rejection; generated files
  stay in the selected workflow workspace and are never executed by Creator.

- **Folder-qualified workflows now keep their own workspace and visible run
  history.** A direct run such as `airflow-dag-builder/plan` defaults to
  `tmp/airflow-dag-builder/plan`, so sibling entries no longer contend for the
  namespace root. When an operator answer starts a continuation, its live panel
  names the source run and retains that run's available settled agents above the
  new work instead of appearing to reset. Current-run counters stay independent;
  if process-local history has already expired, the panel says so and points to
  the durable run status.

- **Wide agent summaries no longer crash the workflow TUI at the terminal
  edge.** Shared live rows now measure terminal columns with `visibleWidth()`
  and truncate by columns, including emoji and other double-width graphemes. A
  210-column workflow panel therefore cannot emit the 211-column summary line
  that Pi rejects as an uncaught render exception.

- **Answers now continue folder-qualified workflows by saved name.** The
  operator handoff service preserves a persisted `target.kind: "name"` when it
  resolves the continuation. Names such as `airflow-dag-builder/plan` no longer
  pass through the legacy `script` alias and become mistaken filesystem paths.

- **Workflow questions can show their source evidence beside the choices.** A
  select or text question may bind one published continuation artifact as
  `detailArtifactRef`. The runtime verifies its identity and digest, redacts and
  bounds the text, then renders it above the options together with the workflow
  and run identity. This lets planning workflows show the concrete blocker,
  three suggested answers, and the custom-answer row in one TUI block.

- **A workflow workspace now owns its active-run lock.** The runtime writes
  `.locus-pi-workflow.lock` inside `outputDir` instead of retaining the lock in
  a separate hashed state directory. Removing the workspace therefore clears
  its ownership and allows an ordinary workflow to recreate and reuse that
  path, while concurrent live runs still conflict and durable child checkpoints
  remain separate.

- **The workflow catalog makes the active choice easier to scan.** The selected
  workflow name now carries the strongest emphasis, its description reads as
  supporting text, and source badges and catalog paths stay visually secondary.

- **The workflow catalog now has Project, User, Package, and History tabs.**
  Tab or Right moves forward, Left moves back, and Up/Down selects only inside
  the active source. Descriptions wrap at word boundaries, rows no longer expose
  authoring-profile jargon, and source inspection shows the exact catalog and
  entry paths. Folder-owned namespaces can be copied intact to Project or User;
  group-only namespaces remain group-only, and existing destinations are never
  merged or overwritten.

- **The Package workflow and command portfolios are smaller.** The overlapping
  `requirements-grill`, `review`, and `review-fix` namespaces are retired;
  `implement`, `live-smoke`, the group-only `task` pair, and modular
  `post-code-review` remain. `/workflows <subcommand>` is the sole command family
  for list, info, status, result, run, and continue; only `/workflow-stop`
  remains as an emergency compatibility alias.

- **Typing `/workflows` no longer scans persisted handoffs on every input
  change.** Command completion defers that synchronous disk work until the
  operator actually types `continue `, preventing slow mounted filesystems such
  as WSL project volumes from freezing ordinary command entry.

- **Planning, approved-plan rendering, and one-step recovery form the visible
  `task` workflow family.** The Package names are `task/plan`,
  `task/implement-plan-template`, and `task/substep`; the shared
  group-only `task` namespace makes their relationship clear while remaining
  non-runnable, so planning still stops for owner review and explicit approval.
  The old `plan` and `plan-implement` names are removed instead of retained as
  duplicate aliases. The separate `implement` workflow keeps its distinct
  post-code-review remediation contract.

- **Workflow folders may now be group-only.** A namespace can contain direct
  `<group>/<child>` workflow files without a runnable root. `/workflows list`
  renders an unselectable group header, children remain directly runnable, and
  `/workflows run`/`info` explain that the group itself is not runnable. Adding
  `<group>/<group>.workflow.mjs` later enables the root without renaming or
  mixing its children.

- **Package diagnostics now fail when the declared extension inventory is
  incomplete.** `locus-pi doctor` still prints every `ok` and `missing`
  entrypoint, but now exits with status 1 when any path from
  `package.json#pi.extensions` is absent instead of reporting process success.

- **Prompt-shelf writes now guide callers to the explicit `set` syntax.**
  `/review`, `/todos`, and `/goal prompt` continue to accept compatible
  free-form writes with their existing stored-content behavior and now mark
  that spelling as deprecated with the equivalent scoped `set <prompt>` command. Empty,
  `show`, and `read` forms remain read-only.

- **The public tool API now has one supported name per capability.** Agent
  delegation uses `spawn_agent`; AST previews finish through `resolve`; human
  questions use `ask`; and bounded continuation uses `loop`. The duplicate
  `task`, `ast_apply`, `askUserQuestion`, `loopControl`, `devext_reload`, and
  `locus_workload_proof` tools were removed. `/devext reload` and
  `/devext hot-reload` were also removed in favor of Pi's built-in `/reload`.
  `ask` retains both option-list and rich single-question schemas, and the todo
  extension adds read-only `todo_read` beside `todo_write`.

- **`loop` now performs real bounded automatic continuation.** `start` and
  `until` persist one state machine per Pi session, dispatch follow-up turns
  through the host, and stop on explicit completion, transport/source failure,
  a default 20-iteration limit, or a default 30-minute deadline. `once` remains
  available for manual one-step continuation.

- **Agents now get one shipped skill for running existing workflows without a
  package-specific executor.** Inside Pi, `locus-pi-run-workflow` calls the
  native `workflow` tool. Outside Pi, it starts the registered slash command
  directly with `pi --mode json -p`; typed start, rejection, and terminal
  receipts expose the canonical run, journal, and result paths. The skill treats
  Pi's process exit as transport status rather than workflow success, leaves an
  awaiting-operator handoff unanswered, and documents `--approve` as broad Pi
  project trust with no sandbox. `locus-pi-workflows` now owns authoring only,
  so run and create requests have distinct routing descriptions.

- **Fusion now requires one explicit capability mode for every member and its
  judge.** `tool-free` keeps catalog personas while disabling package discovery
  and requiring an empty Pi active-tool readback before the first prompt;
  `agent` keeps the existing catalog-agent capability path. Workflow and direct
  Fusion persist the declared mode and fresh host readback in evidence, journals,
  and reports, while replay records the mode without claiming a live readback.
  Direct Fusion configuration is now version 2: operational commands reject
  version 1, and explicit configure/set replacement is atomic and remains
  disabled until reviewed and enabled.

- **The `/ps` agent viewer now gives the transcript more room and clearer
  boundaries.** While one agent's transcript is open, the lower fleet panel
  shows only that agent instead of the full roster. The viewer frame uses the
  theme's muted border color so native tool calls remain visually distinct.
  The interactive input drops its redundant heading and extra vertical gaps,
  leaving one compact send/newline hint beneath the editor.

- **Finished workflow transcripts now end on the useful result.** Interactive
  runs render `Workflow started`, then the bounded `Workflow finished` receipt,
  then the exact `Workflow result`; non-interactive JSON keeps its existing
  terminal-receipt ordering. The completion receipt no longer repeats a clipped
  prose result and groups primary/workspace/result/journal files separately from
  copyable commands. A Package `task/plan` result names `plan.md` in its card and
  shows a review-and-approval-gated continuation through
  `task/implement-plan-template`; that renderer's card prints the explicit-path
  command for `implement-plan.workflow.mjs`.

- **Post-code review now states whether work is mandatory and hands it to a
  separate verified implementation workflow.** Final reports use `READY`,
  `READY_WITH_RECOMMENDATIONS`, `CHANGES_REQUIRED`, or `BLOCKED`; each item has
  an independent `REQUIRED`, `RECOMMENDED`, or `NO_ACTION` level plus impact.
  Actionable items may include small illustrative snippets, never literal
  patches. The new Package `implement` workflow defaults to REQUIRED work,
  intentionally no-ops when nothing is selected, pauses for unresolved owner or
  product decisions, independently verifies live changes, and permits at most
  one corrective pass. It never commits, pushes, opens a pull request, merges,
  or deploys.

- **Post-code review now audits comments and project-specific style from one
  request-local file.** Every fresh review preserves an existing
  `tmp/post-code-review/<review-id>/style.md` or safely creates it empty before
  child work starts. A fourth parallel lane checks misleading, stale, redundant,
  or missing comments and evidence-backed project style; its proposals still
  pass through the sequential necessity challenge before synthesis.

- **Saved workflows now form folder-owned trees.** A canonical
  `<name>/<name>.workflow.mjs` root owns its direct child files, which resolve as
  `<name>/<child>`. Namespace precedence is atomic, `/workflows list` renders
  roots before indented short-name children without absolute paths, and every
  entry remains directly runnable. Existing flat Project/User workflows remain
  compatible; Package workflows now require folders.

- **Standard workflows can attach their own published evidence to an operator
  continuation.** Unchanged references returned by the three publication APIs
  may now flow only as direct elements of
  `awaitOperator.operatorHandoff.continuationArtifactRefs`; derived, nested,
  foreign, or differently routed runtime values remain rejected, and the host
  still verifies origin-run membership and artifact integrity.

- **Modular post-code review now ships as an installable Package workflow.**
  `post-code-review` coordinates one scope child, four parallel audit children,
  one sequential necessity challenge, and one synthesis child from one shipped
  folder, publishes the final Markdown report, and includes a self-contained
  SVG interaction diagram. The necessity challenge requires a proven failure,
  a guarantee owner, a non-duplicated responsibility, and the simplest net
  improvement before synthesis may retain a finding. Explicitly trusted external
  provider guarantees are accepted boundaries rather than automatic demands for
  duplicate local validation. `invokeWorkflow({ child })` binds every short
  sibling name to the exact folder namespace and source selected for the root.

- **Workflow authoring now defines the complete tree before source.**
  `workflow-author` writes `.pi/workflows/<name>/<name>.design.md` with an
  explicit `runnable root` or `group-only` namespace and exact `Entries` table,
  reviews it, then builds only the declared direct children plus the root when
  declared. It never fabricates a root, pauses only for explicit design-only
  work, and cannot report success until every source passes identity, import,
  graph, and source-shape checks.

- **Interactive workflow launches can select a fresh durable workspace.**
  `/workflows run <name> --output-dir <project-relative-path> [input]` passes the
  same safe `outputDir` contract already available to the programmatic workflow
  tool, so repeated semantic targets do not need to share stale checkpoints.

- **Fresh `post-code-review` launches now require an explicit new namespace.**
  Catalog Start, canonical/flat commands, the workflow tool, headless launches,
  and direct runner calls reject omitted or previously used `outputDir` values;
  resume remains bound to the original run and workspace. Other workflows keep
  their existing default workspace behavior.

### Fixed

- **The plan verifier's answer stays the evidence the routing choice reads.**
  Six planning stages now return a short readback instead of retyping the file
  they wrote; the verification stage is the one that must repeat its text,
  because the choice between "ready" and "blocked" and the blocker writer see
  nothing but that answer — they open no files. In a hosted-model series the
  verifier generalised the surrounding rule and replied with 95 bytes
  ("Wrote and verified: … Conclusion: ready.") for a 3,374-byte file, so the
  decision was made from the verifier's own conclusion line instead of its
  evidence: the verdict happened to match, but the independent gate had
  degraded into an echo. The instruction is now contrastive — it says the
  answer _is_ the evidence, names who reads it and that they open no files,
  and calls a summary or a bare conclusion line unusable.

- **The plan verifier no longer blocks a plan for describing something that
  does not exist yet.** The stage that checks the finished plan reopens the live
  project, but its prompt never said that planning implements nothing: on the
  first hosted-model series a verifier confirmed the outcome, the fields, the
  dependency order and the clean reviews, then ran `test -f …/index.html`, got
  status 1, and concluded "blocked" — a blocker no plan could ever avoid,
  since this workflow publishes a plan and stops. A weaker local model in the
  earlier series simply never inspected the project and so never hit it. The
  stage now states that the deliverable's absence is the expected state, that
  it verifies the document rather than the result, and that each step's
  verification is checked for existing and being runnable after that step has
  been performed — never for passing today.

- **The packaged `task/plan` workflow stops planning work its own executor
  cannot do, and stops retyping the files it just wrote.** Every step in the
  plan it produces is executed later by one unattended CLI agent with this
  run's toolset, but nothing said so: an audited plan-then-implement series
  put browser play, screenshots and a stronger-model judgement into its last
  step and lost hours to a blocked run. Composition now states the executor's
  reality and routes browser checks, screenshots, a stronger-model judge, and
  anything a person must sign into a final `Operator acceptance` section of
  `plan.md`; the step-usability review checks the same rule. The three
  reviews must write `## Checks performed` and `## Findings`, because a
  permitted `None.` produced six-byte review files indistinguishable from a
  review nobody ran. Stages that write a file now return a short readback
  instead of repeating its contents — the repetition was ~80% of the final
  answers and injected a phantom "duplicate sections" claim into `plan.md` —
  while verification still returns its complete text, since routing and the
  blocker decide from that text alone. Routing takes no tools and returns one
  quoted JSON string, after an audited run's first routing answer was rejected
  as invalid JSON. Correction short-circuits with `No correction needed.` when
  no review lists an actionable finding, instead of spending tool calls to
  apply two wording fixes. Prompt text only: stage count, JavaScript
  structure, and the standard profile are unchanged.

- **`npm run check:repository` now verifies a checkout that never ran the tests.** The public
  inventory lists `dist/workflow-source-shape.mjs`, but no gate built it: the comparison
  passed only where a committed copy or an earlier test or pack run had left the file behind,
  and reported it missing otherwise. The npm script now rebuilds the artifact before comparing
  the inventory, the same way `prepack` and `pack:json` already do, so the check stands on its
  own and the hygiene scan reads the artifact as actually built.

- **Durable workflow evidence now stays bound to its recorded run and
  workspace.** Resume rejects a missing or different output workspace before
  any child executes; persisted workflow targets, run identifiers, artifact
  indexes, handoff claim/lock sidecars, and published primary files now pass
  the same physical-containment and descriptor-identity checks. Unsafe or
  dangling symlinks fail closed, and claim/lock writes retain their prior
  `fsync` durability.

- **Exact post-code-review resume now proves the source workspace identity.**
  Result envelopes persist a versioned canonical project-relative physical
  identity; malformed, missing, or changed identities fail before lease and
  checkpoint access, without adding another workstation-absolute public field.

- **Post-code-review resume and handoff admission no longer trust mutable result projections.**
  A write-once host-owned launch binding records the validated source target,
  script identity, workspace identity, explicit selection, and semantic input
  digest. Owner resume and handoff paths fail closed when that binding is
  missing or disagrees with `runtime/result.json`; generic and legacy workflows
  remain readable.

- **Workflow discovery, parsing, and completion now share one executable
  command contract.** Invalid directory-shaped project workflows block
  lower-precedence fallbacks, quoted `--output-dir` values complete correctly,
  repeatable options remain discoverable, and the standalone `--` delimiter
  preserves opaque input for both canonical and compatibility commands.

- **Workflow choice routers can opt into a safe degraded route.**
  `agent({ choice, choiceFallback })` keeps the normal two schema-validated
  attempts, then returns the explicitly declared fallback and records the
  validation failure in the runtime journal. The fallback must be one of the
  declared choices and does not mask child execution or transport failures;
  choice calls without it retain fail-closed behavior.

## [0.3.0] - 2026-08-10

### Fixed

- **One agent, one name: the workflow card, `/ps`, and drill now agree.** A
  workflow agent is backed by two live rows — the journal anchor and the SDK
  executor child it spawns — and each minted its own petname, so the workflow
  tool card could say `[agent Wren] working` while the drill-close notice said
  "Perrin continues running" about the same agent, and the card listed that one
  agent twice under two names. The executor row now adopts its anchor's petname
  (shared names are refcounted and released only when the last holder row
  retires), and the workflow tool card collapses anchors in favour of their
  executor children exactly as the fleet panel does, so each logical agent
  renders exactly once under one stable name on every surface.

- **Live agent surfaces no longer flicker on slow terminals (notably Windows/WSL).**
  The agent live store emits once per child-agent SDK event, and every live
  surface turned each emission straight into a terminal repaint. Across the WSL
  console boundary each repaint is a real cross-process write, so `/ps`, the
  fleet panel, and the drill viewer visibly tore while an agent streamed. Live
  repaints are now coalesced to at most four per second — a leading render keeps
  the surface responsive to the change that triggered it, and a trailing render
  guarantees the last state is never dropped. The fleet panel additionally skips
  repaints whose projection is byte-identical to what is already on screen, so
  an idle fleet stops repainting entirely. Keystrokes keep the immediate render
  path, so cursor movement in `/ps` is unchanged. Presenting an operator block
  no longer forces a full-screen redraw (teardown still does, which is what
  clears stale glyphs), and the workflow tool card now ticks at 1 Hz to match
  its own second-granular content instead of repainting four times per visible
  change. Liveness cadence is unchanged: spinners and elapsed counters still
  update once a second.

  On consoles where every repaint itself blinks, throttling alone is not
  enough, so a **calm rendering mode** removes the reason to repaint at all:
  the spinner freezes, elapsed counters move in 10-second/minute buckets, and
  the per-second tool timer is dropped — so an idle fleet renders byte-identical
  frames and the identity gates (now also on the focused `/ps` selector) keep
  them off the terminal entirely. Live surfaces then write only on real state
  transitions. Calm mode turns on automatically under WSL and can be forced
  either way with `LOCUS_PS_CALM=1` / `LOCUS_PS_CALM=0`.

### Changed

- **The README now starts with the operator path instead of the repository
  inventory.** Installation, verification, and the live host smoke appear
  before implementation detail; workflow authoring and the trusted-code
  boundary are separated into explicit sections, while the full Git checkout
  lifecycle remains available for maintainers.

- **The public extension index is now a complete operator inventory.** It
  records recursive file counts for every default-loaded extension and lists
  all manifest-declared tools, commands, hooks, and shortcuts in one place.

- **The workflow tool card names the task it is working on.** A `task:` line
  under the `LOCUS · workflow <name>` header shows the first line of the
  workflow's semantic input, so the operator sees what the run is about without
  opening the drill. The title travels through tool details; cards for older
  persisted results derive it from the call arguments.

- **Directly spawned agents own their own transcript block, answer included.**
  `spawn_agent`/`task` now render a per-agent LOCUS card — petname, live
  status, task title, and elapsed, resolved from the live row while the run is
  in flight — instead of Pi's default tool shell, so a directly launched agent
  is never folded into another tool's block. The child's returned text lands in
  the main window marked with a left bar (`▌`) so it reads as the agent's own
  words: the first line when collapsed, the complete answer when expanded.
  Failures surface their reason as a dim technical line, never as an answer.
  The workflow card marks each completed agent's answer the same way (one line
  collapsed, a bounded block expanded).

- **`spawn_agent`/`task` titles may now be 128 characters (was 48).** The
  48-character schema cap rejected legitimate task titles outright; the stored
  title now clamps at 128 and narrow surfaces keep truncating at render time.

- **Planning now stops for review instead of rolling into implementation.**
  A finished `plan` run reported a "default next action", and the reading agent
  treated that description of the operator's options as an instruction, so
  `plan-implement` could start before anyone had read `plan.md`. The `plan`
  result now states that the run stops, that reading it is not approval, and
  that implementation, implementation todos, and step runs all wait. The
  `locus-task-workflow` skill makes planning and execution two separate user
  turns: it presents the files and ends its turn, creates no todos and calls no
  workflow until the user asks in a later turn, and treats resuming an
  unfinished catalog in a new session as execution that also needs asking for.

- **`plan` now renders the execute script the operator runs next.** A third
  `scripting` agent fills a fixed template — shipped as
  `extensions/workflows/examples/plan/resources/execute-template.prompt.md` and
  loaded through `promptFile()` — with the frozen `## S<n>` blocks, producing
  `execute.workflow.mjs` in the workflow workspace: one literal implementation
  node per step in catalog order, then a summary node that writes `result.md`.
  Every prompt is author-known text, so the generated script parses no catalog
  at runtime, and each step prompt reads its own `history/S<n>.md` first so a
  rerun skips credibly completed work. The file is written only under the
  workflow workspace, never under `.pi/workflows/`, `.claude/workflows/`, or
  `.agents/workflows/`: it is not a registered workflow, resolves only as
  `/workflows run <workspace>/execute.workflow.mjs`, and running it stays an
  explicit operator act against trusted host-authority JavaScript. Plan
  approval is still not run approval, and a graph the template does not express
  — a reviewer between steps, a bounded loop, concurrency — still goes through
  `workflow-author` Design -> explicit approval -> Build.

- **Workflow selection and planning handoff now preserve operator context.**
  Native workflow menus let Pi finish restoring the editor before inserting a
  run or stop command, preventing the transcript from jumping out of view. The
  shared main editor now recalls command history at the end of the command
  instead of moving the cursor to its first character.
  Started, finished, and result messages now have distinct readable cards; the
  completion card separates each unique audit run directory from the reusable
  workflow workspace and names the primary file. The Package `plan` workflow
  now prints default and optional next actions, while `workflow-author` Build
  returns the exact copyable `/workflows run <path>` command without running it.

- **Plan now freezes a boundary-driven task catalog before execution.**
  `plan.md` defines coherent top-level work units, while `steps.md` remains the
  only executable catalog and carries complete flat exact-step blocks for fresh
  agents. The default todo-driven Plan Implement path is unchanged; approved
  artifacts may instead be handed to workflow-author Design for an
  approval-first project-local sequential workflow.

- **Standard workflow authoring now separates transport safety from work size.**
  New generated source omits per-attempt `maxToolCalls` and `timeoutMs` unless
  the operator explicitly requests an override; package defaults and legacy
  workflows are unchanged. Model-discovered `handoffs` examples now use a
  named, domain-derived `maxItems` in the existing `1..100` contract instead of
  teaching `64` as a generic limit. Large approved catalogs use complete
  canonical `steps.md` blocks rendered literally in an optional project-local
  sequential workflow, or exact caller `items` for programmatic embedders. Each
  task gets one implementer and may get one visibly separate reviewer, while
  Design -> explicit approval -> Build and the six-workflow Package registry
  remain unchanged.

- **Main-agent `workflow` tool calls now read as one Locus workflow card.** The
  card names the real workflow and its `RUNNING`, `COMPLETED`,
  `AWAITING OPERATOR`, `CANCELLED`, or `FAILED` state in one stable header;
  partial updates are no longer mislabeled `[RESULT] Workflow`. Explicit
  `[agent <name>] <state> · <work>` rows make the child-agent hierarchy visible.
  A theme-colored left rail contains Locus state, diagnostics, and paths, while
  persisted workflow-produced model text starts outside the rail. Compact,
  expanded, multi-agent, and narrow-terminal projections preserve identity and
  state without hardcoded ANSI colors.

- **The shipped planning pair is now a minimal, resumable agent graph.** `plan`
  runs one reconnaissance agent and one planning agent, which write
  `context.md`, `plan.md`, and dynamic complete steps in `steps.md` under one
  caller-selected `tmp/<select-name>` workspace. `plan-implement` now gives one
  exact step to one implementation agent, which changes and verifies only that
  scope and writes `history/S<n>.md`. Both workflows use the machine-checked
  `standard` profile, use Pi's default workflow agent and configured model
  route, and contain no model pin, plan parser, critic loop, task ledger, step selector, reviewer,
  grader, report renderer, or nested workflow. The new installed
  `locus-task-workflow` skill keeps dynamic routing in the main Pi agent: it
  appends one single-line todo reference per step without replacing unrelated
  todos, reads the exact step block from `steps.md` for one top-level workflow
  run, pauses on blocked history, and reconstructs work from steps plus history
  after a session restart. The host's 20-continuation safety pause resumes with
  `/todo run`.

- **The supported and tested Pi baseline is now 0.83.0.** All four Pi peer
  ranges start at 0.83.0, development dependencies and the lockfile use exact
  0.83.0 packages, and current host-contract documentation is synchronized.
  Locus does not use the deprecated TypeBox APIs removed by Pi 0.83.0.

- **Model-role assignment now starts from the model, like OMP's model picker.**
  `/model-roles` opens the complete model list, keeps provider filtering as an
  optional `Tab` shortcut, and shows “Set as …” role actions below the selected
  model. The old standalone “Available roles” inventory is gone; effort choice,
  persistence, and the six existing role names remain available.

- **Model-less agents now use `AGENT`, then the live `CURRENT` model.** `TASK`
  and the saved `DEFAULT` choice no longer silently replace the main session
  model when `AGENT` is unset. Agents that explicitly declare `TASK` or another
  role still use that role.

- **Workflow files now use one project-local workspace, separate from run
  evidence.** The default is `<pwd>/tmp/<workflow-name>/`, derived from Pi's
  verified session working directory; every child receives its absolute path
  exactly once, saved children inherit it, and the existing physical-root lease
  prevents concurrent runs from sharing it accidentally. Automatic evidence now
  lives under `.pi/locus-pi/runs/<runId>/` with only `outputs/` and `runtime/`.
  Old `.pi/locus-pi/workflows/<runId>/` directories remain untouched and exact
  lookup returns a migration message instead of silently reading them.
  `runWorkspaceDir()` now throws `WorkflowRunWorkspaceRemovedError`; use
  `outputDir()` and `publishPrimaryFile()`. Standard authoring remains a visible
  graph of direct agent calls and exact text/file handoffs, with no author-side
  capability fields, raw schemas/validators, parsers, renderers,
  acknowledgement gates, or answer-repair functions.

- **Pi now has one permanent violet Locus footer and one compact workflow rail.**
  The footer keeps `working directory (branch)` on the left and right-aligns
  `context (pi:auto) model effort`, without redundant `ctx:`, `tok:`, or `git:`
  labels. Active workflows put aggregate tokens before stage/state, omit the
  noisy `active` count, and right-align their available commands. The lighter
  workflow rail is followed immediately by agent rows with elapsed time and
  separate input/output tokens; no workflow rail is shown when no run is active.
  The footer stays on one row while both sides fit and uses a second row only on
  overflow, preserving the location and runtime groups instead of dropping one.

- **A running `spawn_agent` call now shows the generated agent name immediately.**
  The tool card streams the same `agent <name> started` line used by the live
  agent surface as soon as the child receives its stable display name; the
  child's exact final text still replaces that progress line on completion.

- **Selected-agent `/ps` views no longer clear the terminal scrollback during
  live updates and can accept input while the child is active.** The viewer now
  keeps Pi's native assistant and tool rendering inside one terminal-height
  follow-tail viewport; trackpad/wheel scrolling and `PgUp`/`PgDn` browse only
  the selected child's retained transcript, preserve the chosen position while
  live output arrives, and return to follow-tail at the bottom. `Home`/`End`
  remain available when the input editor is absent, while `Ctrl+O` keeps the
  native tool-detail control. Mouse capture is shared across overlapping viewers
  and released when the last viewer closes or the Pi session shuts down. This
  avoids exposing the parent chat as if it belonged to the child and avoids Pi's
  clear-screen/full-redraw path when an older assistant block changes above a
  tall tool result, which was especially visible as flicker under WSL. While the
  exact SDK child turn is streaming, the view also mounts Pi's native editor and
  sends Enter submissions to that child as steering input. Input disappears on
  settlement or execution replacement, and `Esc` still closes the view without
  aborting the child.

- **Selected-agent `/ps` views now separate identity, request, runtime, input,
  and status at a glance.** The first line says `[agent <name>] started work`,
  the retained body labels `REQUEST` and `RUNTIME`, a double rule isolates the
  live `MESSAGE TO AGENT` editor, and the bottom double rule begins with the
  current `STATUS`. The layout remains one terminal-height viewport, including
  when the editor is unavailable or the terminal is too short to show it.

- **Standard workflow source now has an installed, provenance-aware build
  gate.** `npx @kroffske/locus-pi check-workflow-source <path>` checks a workflow
  from its consumer project without a local npm script, `tsx`, or a new runtime
  dependency. The tarball carries a deterministic prebuilt ESM checker, so the
  command also works from a real `node_modules` install where Node refuses
  TypeScript stripping. The repository `check` gate still validates standard
  entries in the unchanged six-workflow Package registry. The grammar treats semantic
  input, plain agent text, and item aliases as opaque whole values while keeping
  runtime-owned choices, list identity/status, and counters available for
  orchestration. It rejects inspection, semantic branching/rendering, item
  renaming, opaque subscript/member/call intermediaries, duplicate
  value-bearing binding names, trusted-name assignment, and false DSL bindings
  from later run parameters. Unused mandatory acknowledgement protocols remain an explicit
  review prohibition rather than a regex over prompt English.
  Callback provenance is fail-closed for every map and pipeline parameter,
  opaque identity maps retain opacity, every computed index is checked, and
  switch-local literal shadows keep their real lexical boundary. Public
  examples now document the global unique value-binding rule and pass the same
  shipped checker used by consumers.
  Standard source also rejects implicit `arguments` and undeclared ambient value
  roots, while arrays, objects, spreads, and nested composites preserve contained
  provenance instead of laundering model/runtime values. Inline callbacks now
  use arrows only, so named function expressions cannot leak a false ambient
  binding into the enclosing scope. Sequence expressions are rejected outright,
  including literal-only sequences, rather than falling through as author-known.
  `Error` construction also accepts only author-known or literal arguments, so
  model/runtime values cannot be laundered through messages, causes, options,
  composites, spreads, or member extraction.
  Every allowed standard DSL method now has one exhaustive return-provenance
  category. Only exact choices, list identity/length, and saved-child status are
  control values; model/file/workspace results are opaque, host
  clock/random/path/publication results are runtime-owned whole values, and
  `awaitOperator`/`log`/`phase` are void effects that cannot be used as values.

- **Workflows can now compose one durable saved-child level into stable project
  output.** The tool accepts a confined project-relative `outputDir`, while the
  existing run-local evidence directory keeps its prior meaning. Workflow source
  can invoke a real saved child per predeclared item key and publish one
  host-verified primary-file reference with path, byte count, and SHA-256 digest.
  Root and children share cancellation, global concurrency, a 10,000 physical
  agent-call fuse, a fenced output lease, and atomic source-bound item
  checkpoints, so retries skip completed work while source changes invalidate
  it. Saved grandchildren and identity cycles fail before model work; stable
  files survive failure. Project source remains live and that policy is journaled.
  New standard source declares profile metadata and uses idempotent file updates;
  the curated registry remains the same six workflows. Runtime and per-call
  deadlines are now 24-hour emergency fuses and child requests use the host
  maximum of 20 turns.

- **The programmatic workflow tool now accepts native text work units.** A main
  agent can pass optional semantic `input` plus exact `items: string[]` in one
  call. Workflow source reads a frozen snapshot with `dsl.items()` and feeds it
  directly to readonly `pipeline()` plus inline `dsl.workflow()` mini-flows.
  Order, whitespace, empty strings, duplicates, and large lists are preserved;
  non-string or unknown fields fail before execution, and no file/parser,
  generic argument object, child metadata copy, item digest, or nested saved run
  was added. The package `totalAgents` runaway fuse is now 10,000 so finite
  fine-grained decomposition can exceed 200 calls while an injected smaller cap
  and the same `WorkflowInvocationCapError` behavior remain available.

- **Workflow children now always receive all available tools.** A
  selected catalog role contributes its prompt and model identity but no longer
  silently narrows `tools`, `readOnly`, MCP access, or permission intent.
  Standard authoring and shipped workflows no longer enumerate tool allowlists
  or create no-tool stages. Legacy per-call restriction fields are ignored;
  actual child requests always use `allowedTools: ["*"]` and remain writable.
  The host-owned direct recursion boundary for `spawn_agent` and `task` is unchanged.

- **Workflow agents no longer accept output-token truncation as success.** If a
  provider ends a child answer with `stopReason=length`, the host fails the call
  as a provider error and preserves its transcript instead of publishing or
  handing off text that may end mid-word.

- **New workflow authoring is approval-first and graph-readable.** A raw request
  to the bundled `workflow-author` now creates only
  `.pi/workflows/<name>.design.md`, recording the selected pattern, algorithm,
  nodes, exact handoffs, roles, edges, bounds, mechanisms, and failure
  exits. Only `Build approved design: <exact path>` creates matching source, and
  Build validates identity and module load without running it. Shipped Markdown
  pattern cards teach small direct-agent graphs; standard generated source passes
  complete text replacements and does not emit domain schemas, validators,
  parsers, renderers, wrappers, or custom recovery.

- **`agent({ choice: [...] })` is the standard machine-routing answer.** The
  runtime accepts 2–32 unique non-empty exact strings and desugars the call to
  its existing string-enum validation path before request canonicalization.
  Choice therefore keeps the same corrective re-ask, replay identity, journal
  evidence, budget accounting, and fail-closed exhaustion as the equivalent
  schema, while raw `schema` and `validate` remain compatible for existing
  advanced trusted scripts.

- **`agent({ handoffs: {...} })` enables bounded runtime-discovered fan-out.**
  A discovery agent can now return 0–100 complete non-blank unique text work
  units with explicit count and per-item bounds. Runtime desugars the declaration
  to its existing string-array validation path, so format repair, replay,
  journaling, budgets, and fail-closed exhaustion remain generic; workflow code
  passes the returned `string[]` directly to visible `parallel()` or `pipeline()`
  workers without parsing prose, declaring a domain schema, or simulating a
  manager agent.

- **Filesystem prompts now state their location explicitly.** Authoring guidance
  requires the exact `projectRoot()` or write-workspace path, so weaker models do
  not redirect relative work into the user's home directory or `/tmp`.

- **Workflow authors can now call `dsl.fusion()` for one bounded multi-model
  answer.** Fusion validates 2–10 unique member selectors and a separate judge
  before spending, sends no ambient chat history, supports identical or
  role-lensed prompts plus explicit supplied context, runs tool-free members at
  the existing four-call concurrency bound, fails before judging when any member
  fails, preserves the packet and every answer as evidence, and returns only the
  judge's exact text or existing schema-validated value. The host resolves the
  complete roster before the first child, and concurrent Fusion calls reserve
  their worst-case invocation counts instead of overcommitting the run budget.

- **The main Pi session can now call Fusion directly as an opt-in `fusion`
  tool.** `/fusion` configures 2–10 concrete member models and a separate judge
  from the host's available-model list, enables or disables the tool immediately,
  reports its current state, and can run a question manually. Fusion is disabled
  by default, so its schema and description do not enter the model's active tool
  context until the operator enables it; direct runs retain the same isolated
  prompts, model preflight, limits, journal, answers, packet, and result evidence
  as `dsl.fusion()`.

- **Finished command-launched workflows now print their complete prose result.**
  After the existing bounded `locus-workflow-run` digest, `/workflows run`
  appends a separate `locus-workflow-result` message containing the exact,
  untruncated terminal text. The result is directly readable and copyable from
  scrollback; structured non-text results remain in persisted run evidence.

- **`/workflows` is now the canonical visible workflow command.** In an
  interactive TUI, bare `/workflows` opens one unified menu with the exact verbs
  `dashboard`, `list`, `info`, `status`, `result`, `run`, `continue`, and `stop`;
  direct typed `/workflows <subcommand>` forms remain available. Other hosts
  receive typed help. Flat `/workflow-*` commands stay as compatibility aliases
  until parity with the unified command is proven, so existing operator habits
  and scripts continue to work.

- **The workflow menu makes each action legible before selection.** The root
  menu shows a description beside all eight verbs. Catalog rows lead with the
  workflow name and a compact `[P]`, `[U]`, or `[PKG]` source badge; history
  rows lead with the workflow name, then run id, then its source badge. On a
  source screen, `Tab` or the Left/Right arrows changes the focused action
  before Enter activates it.

- **Selected-agent `/ps` history includes the original request and every
  retained transcript block.** The terminal-height viewer described above can
  page to the beginning without dropping old assistant or tool content. Existing
  content, byte, and node retention bounds still limit what can be retained and
  displayed.

- **The public extension catalog now gives operators and planning agents a
  concise English roster of all ten default extensions.** It links each
  entrypoint, manifest, and active manual, separates direct feature edges from
  shared-layer and external-package dependencies, and is included in the
  package and public-repository inventory.

- **Workflow run contents now have three stable ownership zones.** Every run
  creates `outputs/` for readable results, `workspace/` for deliberate
  agent-written files, and `runtime/` for journals, result envelopes, replay,
  snapshots, handoff claims, and digest-bound artifacts. All names come from one
  path module, old flat layouts are not read, prose finishes are saved as
  `outputs/workflow-result.md`, and the native tool shows that full text to the
  operator while keeping model-facing content bounded.

- **Workflow runs now live under Pi's project-local extension namespace.** The
  canonical run root moved from `.locus/runtime/workflows/<runId>/` to the
  shallower `.pi/locus-pi/workflows/<runId>/`. The journal, result, artifacts,
  reports, replay records, script snapshots, resources, and retained worktrees
  all use the same owner path, while unrelated goal and agent runtime state
  remains under `.locus/runtime/`.

- **A workflow start now names storage that already exists.** The runner creates
  the non-symlink run directory and writes the budget as the first
  `journal.ndjson` line before `onRunStart` can announce the RunID. Unsafe or
  unwritable initialization fails before the live announcement and before any
  child agent; later journal appends remain best-effort so a presentation-side
  logging fault cannot crash an already-running workflow.

- **`plan-implement` accepts a plan instead of requiring a filename.** One
  host-verified continuation artifact is still supported at any accepted size,
  but its name no longer has to be `plan.md`. Without a continuation, the
  workflow uses a read-only resolver to accept either pasted plan text or one
  file path, then sends the resolved plan through the existing deterministic
  step parser and implementation/review pipeline.

- **Planning now starts from the result the operator will use.** `plan` records
  one primary result, its consumer, location, required content or behavior, and
  usability proof before deriving implementation steps. `plan-implement`
  requires that contract, records command outcomes as structured evidence, and
  cannot return success after a failed or unrun check, an evidence gap,
  run-attributable unexpected work, or a non-ready result. Step dependencies are
  now enforced for subset runs, and one bounded reconciliation may build a
  missing result after the selected steps finish. The primary output is now
  `workflow-summary.md`, while `implementation-report.md` remains supporting
  per-step evidence.

- **Accepted plans now describe one bounded agent subtask per step.** Every new
  `S<n>` block carries `Context:`, one `Question:`, and one `Output:` contract;
  planning may emit dozens of explicit item-sized steps instead of sending one
  agent across an entire collection. Different reasoning over one source — for
  example literal Airflow metadata versus a description inferred from DAG code
  — stays in separate steps, and final aggregation is an ordinary dependent
  step. `plan-implement` preserves legacy plans, validates the new three-part
  contract as a unit, rejects missing or shared output paths, repeats the
  contract in the individual writer prompt, and accepts up to 80 selected steps.
  A stalled `plan` run now tells the operator to continue that run with guidance
  instead of editing `plan.md` and starting over.

- **The public extension index is now a source and dependency map.** It links
  every default extension to its entrypoint, manifest, and active manual;
  distinguishes direct feature imports from shared-layer and external-package
  dependencies; and corrects the ownership documentation's stale count of four
  Package workflows to the six that ship.

- **Declining a workflow question is now an answer, not a postponement.**
  Pressing Escape on a workflow's operator question used to set a session-local
  snooze the running workflow never heard about, leaving the run parked. It now
  continues the workflow with plain text — the questions that were asked, each
  marked answered or declined, under the line `The operator declined to answer
this workflow's questions.` — through the same continuation a typed reply
  takes. The runtime attaches no handling contract to that text: what a declined
  question means is the workflow author's decision.

- **A workflow question is raised automatically only by a run of the current Pi
  session.** The extension's session-start scan over every project run, and the
  blocking modal it raised, are gone; so is the same question arriving one turn
  later, because the automatic pump now considers only runs this session started
  — its own launches and the continuations they spawn. The split-run gate is
  unchanged: a run started here that ends awaiting an operator still opens its
  question the moment it settles. A question published by an earlier session
  remains in its run's evidence and is reopened only when the operator asks:
  `/workflows` for the oldest pending one, `/workflow-continue <runId>` for a
  named run — both still project-wide.

- **A file a workflow agent writes now exists under the name the agent gave
  it.** Each run gets a working directory,
  `.pi/locus-pi/workflows/<runId>/files/`, created before the script starts,
  handed to the script as `dsl.runFilesDir()` and named at the top of every
  child agent's prompt. Nothing renames, numbers or moves what an agent writes
  there, so a path a workflow prints in a question is a path that can be opened.
  A read-only child is told where the directory is and is not asked to create
  anything in it.
  Auto-captured material moved with it: the run report — `task.md`,
  `result.md`, the current revision of every published document, and the
  `README.md` that indexes revisions, budget and logs — is now written to
  `.pi/locus-pi/workflows/<runId>/logs/`, and the mirror under
  `<project root>/.locus-pi/<runId>/` is no longer written or read. Write order
  and revision history are recorded in the README, not in file names.

- **Every child agent session is now saved as a readable HTML render beside its
  JSONL transcript**, under the same base name in the call's transcript
  directory. The render is additive — the Pi TUI reader stays the required
  surface — and it is never silently skipped: the verified path is recorded on
  `childTrace.htmlPath` in the call's result envelope, and every reason a render
  is missing (a host without `AgentSession.exportToHtml`, a renderer that threw,
  an unusable output) is recorded as an `HTML transcript render …` warning in the
  same envelope. `pi --export <transcript>.jsonl <out>.html` re-renders any saved
  transcript afterwards.

- **The run report is a document-update cycle, not a pile of numbered copies.**
  `.locus-pi/<runId>/` used to hold one `NN-<author>-<name>` file per artifact
  write, so a six-round plan run ended with six `plan.md` copies under six
  different names, and the current plan was a filename guess. An artifact name is
  one document now: the report writes ONE file per name holding its newest
  revision (`plan.md` is the plan as the run left it, including on a stalled or
  failed run), and the README's `## Documents` list shows every revision — who
  wrote it, at which stage, on which model — each linking the verbatim bytes in
  the machine store, so no history is lost and none of it is duplicated. A
  revision transferred from a previous run (a continuation input) is part of the
  same chain, which is what keeps a continuation's questions and answers from
  reappearing as fresh documents. The README also grows a `## Logs` section:
  the run's `journal.ndjson` — one line per event, tagged with its agent, stage
  and round — and every child transcript linked by its stage label, so the raw
  ndjson evidence is one click away instead of a directory dive.
  The report also says which document is the answer: the one whose newest
  revision is the run's terminal text is marked **final result**, and a run that
  produced none says so plainly rather than leaving a rejected draft to be read
  as one. `README.md`, `task.md` and `result.md` stay runner-owned names — but
  only when the report actually writes them, so a workflow that publishes its own
  `result.md` keeps the name; a document that still collides takes a `-2` suffix
  instead of overwriting. Every copy of the operator task folds into `task.md`,
  including the transferred one a continuation consumes, which retires the
  byte-identical `task-2.md` that used to lead a continuation's document list.
  A run that did not complete gets a `## Why this run ended` section carrying
  the full failure reason — the structured result rendered as Markdown — because
  every live surface clips that text and a structured result otherwise left the
  defects readable only inside `result.json`.

- **`plan`'s round cap hands the stall to the operator instead of burning the
  run, and its critic ratchets instead of relitigating.** A live run showed the
  failure this fixes: a critic on a weak model returned a different set of
  plausible objections every round, hit the cap, and the operator was left with
  a dead `ok:false` run — no plan, no reusable state, restart from nothing.
  Two changes close it. Each round's critic now receives the defects it reported
  on the previous draft and judges those first — closed, or answered under
  `## Critique responses` with evidence — and a NEW defect must meet the
  existing implementer-would-go-wrong bar; reopening an unflagged aspect of an
  unchanged draft is named in the prompt as the way the loop fails without
  producing a plan. And reaching `MAX_PLAN_ROUNDS` without an acceptance now
  retains the stalled state (`task.md`, `context.md`, the last `plan.md`,
  `unresolved-defects.md`) and declares an operator handoff with one text
  question — a select offering `accept last draft` with free text allowed, so a
  near-miss on a typed phrase cannot silently become drafting guidance. All four
  refs are published together immediately before the handoff, the task included
  even though the run already published it: the terminal artifact projection
  keeps only the newest 20 outputs, and a stage re-asked on a schema rejection
  writes an artifact per attempt, so a ref published at the start could be
  evicted and fail the run on its last step after paying for every round.
  Answering `accept last draft` takes the retained draft as the plan —
  the operator overruling the critic, recorded as such — or answer with drafting
  guidance and the continuation run redrafts from the retained state without
  re-scouting, with the guidance outranking earlier defects for planner and
  critic alike. A draft nobody accepted still never flows onward on its own;
  what changed is who ends the stall.

### Fixed

- **The `plan` run report no longer credits the critique stage with documents it
  never produced.** The round-cap handoff republishes the task, the scout's map,
  the last draft and the open defects so all four are the run's newest outputs,
  and `publishArtifact` tags whichever stage happens to be current — which filed
  the scout's map in the reader's copy as `workflow · critique-plan`. The
  continuation's accept path was worse: it publishes outside the drafting loop
  entirely, so the accepted plan read as an anonymous workflow document rather
  than the operator's recorded decision. Both publish sites now name their own
  stage, `await-operator` and `accept-draft`, and both are declared in
  `meta.phases` and drawn on the pipeline diagram. Neither is on the path of a
  run that ends normally.

- **Answered handoff questions are not re-asked unprompted after their
  continuation fails.** When a continuation run consumed an operator's answers
  and then failed or was cancelled, the handoff became actionable again and the
  idle pump reopened the same questions in the editor automatically — on top of
  the failure the operator actually needed to read, and swallowing the keyboard
  (a mounted question owns the single editor slot, so `/ps` and every other
  command cannot even be typed until Escape). Such a `retryable` handoff now
  opens only on an explicit ask — bare `/workflows` or
  `/workflow-continue <runId>` — and the unprompted pump instead shows a
  one-line notice (once per session) naming the run and how to reopen it.
  Never-answered handoffs keep their existing behavior: the oldest pending
  question still opens by itself when Pi is idle.

- **One dropped surface no longer takes the session's keyboard with it.** Pi
  resolves a `custom()` interaction only from its own close callback, so a
  component torn down any other way — the agent fleet's session-scoped
  `invalidate()`, which runs on every session start, shutdown and reload — left
  that promise pending forever. The awaiting caller is a slash-command handler,
  and Pi's interactive loop awaits the handler before it re-arms the editor
  callback, so one stranded `/ps` stopped **every** later command in the session
  from being dispatched: the editor still accepted text and Enter still cleared
  it, and nothing ran. A question mounting over the dead surface restored the
  editor and made the session look healthy again, which is why this read as
  "`/ps` stops working after the clarification questions". Two changes close it:
  a component disposed without ever reporting now fails its caller with a stale
  interaction instead of leaving it awaiting, and the fleet menu is closed
  through its own `done` — the way Escape closes it — so Pi hands the editor
  back. A component that disposes itself and then reports, which the agent
  viewer's Escape does, is unaffected.

- **A failed run now says which command prints the reason it failed.** Both
  finished-run surfaces cap what they print — the chat digest at 160 characters
  because it enters model context, the panel at the terminal width — and both
  already named `/workflows result` for a run whose result is prose. A run that
  ended badly with a structured `{ ok: false }` result had no such line: the
  operator was left with a sentence fragment ending in `...` and a journal path,
  and the defects that explain the failure were only in `result.json`. Both
  surfaces now add `read the full reason: /workflows status <runId>` for any run
  that did not complete without prose to open. `/workflows result` is not
  offered there, because it refuses a non-prose result and would be a dead end.

- **A stale agent catalog no longer fails every workflow step closed.** Before
  model tiers were executed, the shipped agents wrote their tier as
  `pi/<role>` — `pi` was never a provider and nothing read the value. Once a
  slash started meaning a real provider, any copy of that catalog still on disk
  (a user-level `~/.agents/agents/`, a project `.agents/` vendored from an older
  release) turned every child call into
  `Agent "default" frontmatter model "pi/task" could not be used`, with no child
  created. An agent's frontmatter tier in that namespace is now read as the role
  it always named, so it resolves through the model-roles table like any bare
  tier: assigned, it runs the assigned model; unassigned, it inherits the
  session model and the recorded degradation carries the extra sentence naming
  the spelling to fix. The repair is bounded to package history and does not
  weaken the fail-closed rule: `pi/<not-a-role>` is still an unresolvable
  provider and still refuses by name, and a per-call `model` / `modelRole`
  written today against the current grammar refuses with the migration hint
  rather than being silently rewritten.

### Changed

- **The packaged `plan` → `plan-implement` pair no longer names a provider.**
  Every stage in both workflows pinned the concrete model
  `openai-codex/gpt-5.6-luna:medium`, which fails the stage by name — with no
  child created — on every host that does not have that exact model, so the only
  runnable curated pair in the package was runnable for one vendor's customers.
  Both now declare `modelRole: "agent"`: assign `AGENT` in `/model-roles` to
  choose the model and its reasoning effort, or assign nothing and every stage
  runs on the current session model with the degradation recorded in the run
  evidence, the same as any other unassigned tier. Concrete pins remain the right
  option for a workflow you keep to yourself, and the fail-closed behavior of a
  concrete selector is unchanged. Recorded runs of either workflow are not
  replayable across this change: the tier is part of the request key, so a
  `--resume` of a run recorded before it re-runs its calls for real.

  The repository-only `excalidraw-pipeline` reference is converted the same way —
  its authoring and repair stages move from `openai-codex/gpt-5.6-luna` to the
  `agent` tier, joining the draft stage already on `smol`, so no shipped or
  referenced workflow names a provider. The acceptance claim that pin carried is
  a claim about a run, so it moves to that reference's README, which now names
  the model the recorded run used and how to assign it.

- **Workflow model effort is now executed, not merely displayed.** A concrete
  `provider/id:level` selector passes both the resolved model and `level` to the
  Pi child session, and a missing model fails by name instead of silently
  substituting the parent session. The planning safety cap
  is now six rounds after a real external inventory plan exhausted four while
  still carrying two repairable verification defects. The same live run exposed
  a second boundary: all per-step reviews could pass while the combined result
  remained partial. A validated structured grade now accounts for every selected
  step, drives one bounded reconciliation of only the partial rows, and becomes
  the source of truth for selected-task state and disjoint completed/unresolved
  result rows; deterministic code combines it with the full ledger for the
  reader-facing report. Any remaining partial or blocked grade is returned as
  non-success rather than `completed`.

- **The shipped `plan` → `plan-implement` pair now carries an explicit,
  resumable task lifecycle.** `plan` still produces the accepted ordered
  `S<n>` plan; `plan-implement` turns the selected steps into a persisted
  `implementation-tasks.md` ledger, then runs one writer and one independent
  reviewer at a time. A reviewer can request one bounded repair attempt before
  the workflow advances, while a blocked task stops later work and preserves the
  completed-task evidence. Stable labels keep `--resume` replayable instead of
  applying finished tasks again.

- **Packed Markdown links are now checked against the actual npm tarball.**
  Relative links in shipped documentation must resolve to packed files, while
  repository-only references are labeled as paths instead of dead links. The
  two workflow diagrams referenced by public manuals are now included in the
  package, and generated `.locus-pi/` workflow reports are ignored by Git.

- **The README now documents the complete Git-clone installation lifecycle.**
  It distinguishes stable `main` from integration `dev`, shows user-scoped
  registration that works from every directory, explains update and uninstall
  commands, and identifies duplicate user/project registrations as the reason
  Pi can fail only inside the `locus-pi` checkout.

- **The two catch-all files are gone, and `extensions/_shared/` is now nothing but its six
  named layers.** `types.ts` and `state.ts` held unrelated contracts and one shared mutable
  object between them; each export moved to the module that owns its lifecycle and both files
  were deleted. The agent-definition contract now lives beside the parser that mints it, the
  evidence-evaluation contract beside the evaluator that produces it, the output bounds beside
  the truncation that applies them, and the permission and audit shapes inside the security
  gate that is their only reader. Their package paths changed accordingly; nothing about their
  behavior did.
  **These two were split by domain rather than moved, because they never had one owner.** A
  file named `types.ts` invites the next unrelated contract, and every reader of one export
  had to scroll past nine others belonging to somebody else. Removing an export from it meant
  checking ten extensions, which is the same problem the shared directory itself had, one
  level down. There is now no file in the package whose name describes its shape instead of
  its subject.
  **The one constant that could not go where it reads like it belongs got its own module.**
  The closed agent failure-cause list reads like it belongs to the agent envelope, and the
  envelope re-exports it, but the envelope imports `node:crypto` and the host-agnostic
  workflow core reads the list as a value — so defining it there would have pulled a host
  dependency into the core. It is now a module with no imports at all, which is the property
  the core actually depends on, stated where a reader will find it instead of inferred from
  the absence of import lines.
  **Seven exports had no consumers and were deleted rather than relocated.** The extracted-plan
  and plan-task shapes, the whole catalog-entry family, and a second goal-state interface with
  its context formatter — shadowing the live goal state in the project layer that every real
  consumer imports — were reachable only from each other or from fields of the deleted state
  object, along with three of that object's own fields. Four more union types stayed,
  un-exported, next to the one interface that names each: they were never imported from
  outside their own file, and an export nobody imports is a promise the package was making
  for no one.
  **The mutable object became two caches, one per owning extension, and the ledger says so.**
  Its `agents` map was read and written only by the agents extension and its todo fields only
  by the todo extension, so one shared object was hiding two unrelated single-owner caches.
  Neither survives Pi's cache-disabled entrypoint loading — each loaded entrypoint gets its
  own copy — so the todo cache keeps its documented role as a last-resort fallback in front of
  the durable session store, never a source of truth, and the ownership ledger now names both
  bindings where a reviewer will see them.
  **The last declared exception to the layer order is gone.** The ownership guardrail carried
  one named upward edge, from the host-layer output truncation to the provisional catch-all it
  read its defaults from. Those defaults now sit in the host module that applies them, the
  exemption is deleted, and the rank order is enforced for real on every shared edge with no
  provisional classification left anywhere in the ledger.
  **The hazard that broke two earlier slices was swept for and was absent again.** Every
  file created or moved was checked for `import.meta.url`, `__dirname`, `fileURLToPath` and
  any path anchored on the module's own location — the failure that twice silently
  repointed a moved module at a directory that no longer existed. There was none: the two
  deleted files built no paths at all, and the one module in the package that does count
  directory levels from its own location, the bundled agent catalog loader, only gained type
  declarations and did not move.

- **Six modules that only ever had one consumer now live in the extension that owns
  them.** The AST engine moved to `extensions/ast-structural-edit/`, the extension
  inventory to `extensions/devext-doctor/`, the human-decision journal to
  `extensions/ask-user-question/`, the tool classifier and audit ring to
  `extensions/security-gate/`, and the draft-session runner and behavioral mode state to
  `extensions/plan/`. Their package paths changed accordingly; nothing about their
  behavior did.
  **`_shared` is for code more than one extension needs, and these were not that.** A
  single-owner module sitting in the shared directory told every reader that any of ten
  extensions might depend on it, so removing an export meant checking all of them; it
  also gave a second extension a shared-looking place to reach for logic that was really
  one extension's implementation. Each of the six is now behind the boundary of the
  extension that uses it, and `_shared` is down to the code that is genuinely shared.
  **The one module that looked shared was checked before it moved, not after.** A test
  under `tests/extensions/ast-structural-edit/` imports the tool classifier, which reads
  like the AST extension depending on it. It is not: that test loads the security gate
  itself to assert what the gate audits when an AST edit passes through it, and no
  production file under `extensions/ast-structural-edit/` reaches the classifier
  directly or through anything it imports. The classifier has exactly one production
  consumer, the security-gate entrypoint, so it moved with the rest.
  **Only the two catch-all files are left flat.** `types.ts` and `state.ts` still sit in
  the shared root, and they stay there until they are split by domain: their contents
  have several different owners, so filing them under one layer would assert an owner
  none of them has. Every other module under `extensions/_shared/` now names its layer
  in its path, and no module is waiting to leave.
  **The hazard that broke two earlier slices was swept for and was absent again.** All
  six modules were checked for `import.meta.url`, `__dirname`, `fileURLToPath` and any
  path anchored on the module's own location — the failure that twice silently repointed
  a moved module at a directory that no longer existed. There was none: every path these
  modules build starts from a caller-supplied project root, an environment override, or
  the home directory. The AST engine loads its Python grammar by package name rather
  than by file path, so its dynamic grammar registration resolves from the new directory
  exactly as it did from the old one, which the Python search, rewrite and
  language-override tests continue to prove.

- **The five remaining shared layers are now real directories.** Twenty-eight modules
  moved out of the flat `extensions/_shared/` into the layer that owns them: the host
  facade and its primitives into `host/`, the ten operator-UI modules into `operator/`,
  the session store, artifact store and event bus into `runtime/`, model selection and
  display into `model/`, and goal, prompt, task and todo state into `project/`. Their
  package paths changed accordingly; nothing about their behavior did. With the
  agent-runtime layer that landed before it, every declared layer now exists in the tree,
  so the owner of a module is legible from its path instead of from a table in a script.
  **One module was filed under the wrong layer, and the check had said so in advance.**
  `runtime-capabilities.ts` was classified `host` but imported the runtime-layer session
  store — a rank inversion the ownership ledger carried as a named, temporary exemption
  rather than papering over by loosening a rank. The recorded choice was to either move
  the module or split the store construction out of it; the evidence decided it. Every
  consumer imports `createSessionStore`, so the store-construction half is the module's
  whole reason to exist, and the capability report reports on that same store; nothing in
  `host` or `operator` imports the module at all, so it owed nothing to a lower rank. It
  is now a `runtime` module and the exemption is deleted, which means the rank order is
  enforced for real on that edge instead of being waived.
  **The two catch-all files stayed where they are, deliberately.** `types.ts` and
  `state.ts` hold constants and mutable state with several different owners, so they are
  split by domain rather than moved as units; filing them under a layer now would assert
  an owner none of them has. They remain flat until that split happens.
  **The hazard that broke the previous two slices was checked and was absent.** Twice
  before, a module that derived a path from its own location silently repointed at a
  directory that no longer existed once it moved one level deeper — the workflow example
  registry, then the bundled agent catalog. All twenty-eight modules were swept for
  `import.meta.url`, `__dirname`, `fileURLToPath` and any path anchored on the module's
  own location; every path they build is anchored on a caller-supplied project root
  instead, so there was nothing to repair. The two module-cache-disabled proofs for the
  process-global command-UI and operator-status registries continue to pass across their
  moves.

- **The agent execution stack now lives in a named layer.** Thirteen modules — agent
  discovery, the run boundary, the SDK host, the read-only tool policy, live rows, the
  live transcript, petnames, the system prompt and its context extras, evidence
  evaluation, workload proof and the fleet menu — moved from `extensions/_shared/` to
  `extensions/_shared/agent-runtime/`. Their package paths changed accordingly; nothing
  else about them did.
  **`_shared` was flat, so its declared layers did not exist as anything.** The
  ownership check had already assigned every module a layer and a rank, and enforced the
  import direction between them, but all forty-nine files still sat in one directory —
  so the layer a file belonged to was invisible in the tree and knowable only by reading
  a table in a script. This is the first layer to become a real directory, which also
  turns on the rule that a file's directory must equal its declared layer: from here a
  module cannot be filed under the wrong owner without the check saying so.
  **A path-only move would have silently emptied the bundled agent catalog.**
  `agents.ts` derives the package's bundled `.agents/agents` directory from its own
  `import.meta.url`, two levels up. One directory deeper, that walk resolves to
  `extensions/.agents/agents`, which does not exist — and agent discovery does not treat
  a missing bundled directory as an error, so `/agent list` would have quietly dropped to
  project and user catalogs with the ten shipped agents gone and nothing reported. The
  derivation now goes three levels up and resolves to the same directory it always did;
  a sweep of all thirteen modules for self-referential paths found this one and no other.
  **The agent executor was two things in one file, and only one of them runs.**
  `agent-executor-host.ts` held both the prompt capsule and text-result layer that every
  live agent execution goes through, and the superseded replacement-session executor that
  the source audit records as retained provenance. The live half — the exact three symbols
  the SDK host imports, plus the parent-context assembly they reach — is now
  `agent-execution-prompt.ts`, and the historical module imports it rather than exporting
  to it. So the production surface is the whole content of one file instead of a third of
  a large one.
  **The historical half was not deleted, and that was a judgement call.** Nothing
  registered reaches it: no entrypoint, and no source outside the module itself. On reach
  alone it could go. But retaining it is a written decision in the source audit rather
  than an oversight, and overturning a standing decision is not what a relocation is for
  — so this change made the boundary visible and left the decision to be taken on its own
  merits. One consequence is recorded rather than acted on: the only reason
  `agent-workload-proof.ts` is shared at all is a single read from inside that historical
  path, so retiring it would free that module to move into the agents extension, which is
  its only other consumer.
  **The fleet menu's process-global state now has the proof it never had.**
  `fleet-menu.ts` owns a versioned `globalThis` slot holding the menu's focus and cursor,
  and moving a module that owns such a slot is how live state gets duplicated: Pi loads
  every registered entrypoint with the module cache disabled, so the agents and workflows
  entrypoints each hold their own instance and only the slot makes them agree. The
  ownership check verifies statically that one module names the slot — a source-level
  count that cannot see the failure that matters. With two copies, a menu focused through
  one entrypoint is invisible to the interrupt guard living in the other, and a close
  performed by a peer is a silent no-op that leaves the first side believing it still
  holds focus. A new test loads two entrypoints through the real loader, has each
  subscribe before either mutates, and then has one open and focus the menu and the
  _other_ release it — confirmed by duplicating the registry and watching the slot-level
  assertions stay green while every cross-entrypoint one failed.

- **The workflow runtime now lives in the extension that owns it.** Fourteen
  `workflow-*` modules — the DSL core, the script loader, the journal, the agent
  bridge, replay, artifacts, budget, worktrees, results, run reports, resources,
  handoff, failure diagnostics and script identity — moved from
  `extensions/_shared/` to `extensions/workflows/runtime/`. Their package paths
  changed accordingly; nothing else about them did.
  **They were never shared.** `_shared` had grown into a flat bag of 63 modules,
  and these fourteen were the largest thing in it that only one extension used:
  they import each other densely, and the only thing any other extension reads from
  them is workflow run persistence, which already goes through the read-only door
  added alongside. So "shared" described where the files sat rather than who
  depended on them. Moving them one at a time would have meant a slice whose module
  imports its own siblings across a directory boundary, so they moved as the one
  subsystem they are.
  **A path-only move would have broken the workflow registry.** The Package
  workflow registry is discovered by walking a directory derived from the loader
  module's own `import.meta.url`, two levels up and back down into
  `workflows/examples/`. Relocating the loader repoints that walk at a directory
  that does not exist, and every shipped example disappears from `/workflows` with
  no error raised anywhere. What catches it is the public-registration test that
  asserts the exact six shipped names — confirmed by leaving the derivation
  unfixed and watching it report an empty registry. The derivation now goes one
  level up, and the registry resolves to the same directory it always did.
  **The journal's process-global registry now has the proof it was missing.**
  `workflow-journal.ts` owns the versioned `globalThis` slot that holds workflow
  journal writers, and moving a module that owns such a slot is exactly how live
  state gets duplicated: Pi loads every registered entrypoint with the module cache
  disabled, so each entrypoint holds its own instance of the journal and only the
  `globalThis` slot makes them agree. The ownership check verifies statically that
  one module names the slot, which is a source-level count and cannot see the
  failure that matters — with two copies of the map, a terminal journal line from a
  second entrypoint finds no writer for its key and returns early, leaving the live
  row stuck at `working` and the writer entry never cleared. Nothing proved that
  did not happen. A new test loads two entrypoints through the real loader and has
  each one close the writer the _other_ opened, in both directions, which only
  works on one shared registry.
  **Model resolution turned out not to be workflow-owned, so it stayed shared
  instead of moving.** Fourteen of the fifteen modules were workflow internals. The
  fifteenth — "which concrete model does this selector name" — is called by the
  workflow agent bridge and by the agents extension's interactive `/agent run`, and
  that sharing is the point: it is what keeps one agent name from running on two
  different models with nothing in the evidence to explain why. Its own
  dependencies are the host facade and the shared model-settings grammar, nothing
  workflow-specific. A module with a first-class consumer in each of two extensions
  is what the shared directory is for, so it now sits in the shared model layer
  beside the model-settings and live-display modules that are shared for exactly
  the same reason. Moving it into one of its two consumers and punching a door
  through for the other would have dressed a genuinely shared dependency up as a
  borrowed one — the failure mode this whole refactor exists to end, since ownership
  here follows real consumers rather than a `workflow-` filename prefix.

- **A workflow stage can now say which model it runs on, and the evidence names
  the model that actually ran.** Per-call model selection was written down in
  three evidence surfaces and reached the child in none of them: the resolver
  imported `getModel` from a path the pinned host no longer exports it from, so
  every selector resolved to nothing and the bridge fell through to the parent
  session's model — while the journal, the live row and the run-result artifact
  all reported the selector as if it had run. The shipped Excalidraw reference
  pipeline pinned a model and carried a comment claiming the pin "keeps that
  claim honest"; the comment was false, and the run evidence agreed with it.
  Selection now resolves through the host's own model registry, and the resolved
  model is what `createSession` receives.
  **Two options, one meaning each.** `model: "provider/id"` names a concrete
  model; `modelRole: "smol"` names a tier in the roles table. A slash means a
  real provider, no slash means a role. An optional
  `:off|minimal|low|medium|high|xhigh` suffix is display-only — the child's
  reasoning effort is not plumbed through yet, and the authoring guide says so
  rather than letting the label imply otherwise. Both spellings take the suffix:
  it is split off before the lookup, so `smol:high` resolves the `smol` tier
  rather than searching for a role by that whole name. Those six words are
  reserved in role names; any other suffix stays part of the name.
  **The two failure modes are deliberately different.** A concrete selector this
  host cannot resolve ends the call with a named reason and zero child sessions —
  a typo must not silently run something else. A role that no configuration
  assigns degrades to the session model and records the degradation on
  `agent_end`, in the `locus.agent.run-result.v1` body and in the run report. The
  package ships **no** role assignments and will not choose a vendor for you, so
  a workflow naming `smol` still runs on a fresh install, and the evidence says
  the tier was not honoured. A role you DID assign but mis-spelled (`"smol":
"gpt-5.6-mini"`, missing the `provider/`) is a third case and fails by name: it
  is a configuration error, not an unassigned tier, and degrading it would run the
  session model under the name `smol` while reporting the role as unassigned —
  which the operator's own config file contradicts.
  **"Executed model" is read back, not remembered.** `agent_start` is written
  before anything resolves, so it now carries `requestedModel` under a name that
  says requested; `agent_end` carries `executedModel`, read from the child
  session after it was created. A peer that exposes no model records
  `unavailable` — never the request echoed back — and a readback that
  contradicts the resolved request fails the call with both values quoted.
  `executedModel` and the recorded degradation appear only once the child's first
  prompt has been accepted by the transport: a session built and then cancelled, a
  session built on the wrong model, and a `prompt()` the transport rejected — no
  credentials, no route — executed nothing and say nothing. The live row obeys the
  same rule and, on those paths and on a tier refused before any session exists,
  drops the model label instead of ending as a terminal row wearing a selector that
  never ran — including a replayed completion, which is served from a record with no
  child at all. Absent is honest; the failure reason carries the details. Read the
  other way, the rule keeps evidence rather than dropping it: a failure _after_ the
  child answered — a script `validate` that threw, an artifact that could not be
  written — carries the executed model on its error line and keeps it on the row.
  **Replay identity follows the tier.** `modelRole` joined the canonical request,
  so two stages on two tiers occupy two records; the replay schema version went
  to 2 so a pre-fix record refuses with `no-recorded-calls` instead of the
  misleading `key-mismatch`. Known residual, documented and tested: the key
  carries the tier's NAME, so remapping a role in `.pi/model-roles/config.json`
  does not invalidate a recorded run — discard those runs by hand.
  **The ten bundled agents changed namespace.** They declared `model: pi/<role>`,
  which no resolver ever read; now that a slash means a real provider, that value
  would name a provider called `pi` that no host has. They now name their tier
  bare (`model: smol`). An installed agent catalog that still says `pi/<role>`
  will fail closed with a message naming the file's value and the bare form to
  replace it with.
  **`/agent run` and `spawn_agent` resolve the same chain**, so the same agent no
  longer runs on different models depending on how it was started. The
  write-only `AgentDefinition.modelOverride` field and its undocumented
  frontmatter alias are gone; nothing read either.

- **A live end-to-end run exposed three ways the curated pipeline lets a weak
  model off the hook, and all three are now closed in the prompts.** The run
  built a small application from one sentence, and everything it produced worked
  — which is exactly why the failures are worth naming: they are failures of
  scrutiny, not of output.
  **Coverage was accounted at the wrong granularity.** `review` keys its
  accounting to inventory ids, so the id set is the ceiling on how fine every
  later stage can be. The inventory produced one id for a whole 384-line new
  file, and units, questions, the coverage assessor and the final ledger all
  inherited it; "every id accounted for" became true and meaningless, and the
  rendering and input layers of that file were never questioned. The inventory
  prompt now states that one path may carry several ids when a reviewer could
  accept one part and reject another independently, bounded by
  `MAX_IDS_PER_PATH` and `MAX_INVENTORY_IDS`. The interrogator gained the
  matching bound — at most two questions per unit and forty in a set — because
  the opposite failure is real: it must repeat the whole set verbatim every
  round, and a set a weak model cannot reproduce exactly corrupts the ledger it
  feeds.
  **The question loop could not report an honest exit.** It broke out before
  assessing its final round, so once the assessor asked for a third round,
  "stopped at the cap" was the only reachable outcome and a reader could not tell
  a complete question set from one still under argument. The final round is now
  assessed as well — the verdict there is evidence, not a branch — and any gap
  that survives reaches the verifier as a declared limit of the review, never as
  a finding, since no question was asked about it.
  **The plan critic treated a broken plan as a matter of taste.** It accepted a
  plan whose every step omitted the mandatory `Depends on:` line, whose second
  step bundled six independent decisions, and whose every verification was a
  human looking at a screen — while its own reasoning named two of those as
  problems. A missing mandatory step line is now a named defect rather than
  formatting, and so is a verification that cannot pass at its own place in the
  order. The planner is no longer allowed to end a step with "the observation
  that proves it worked": it must write one command a later agent can rerun
  without a human, with the output that proves the step worked, and a human
  observation only when the step says why no command could exist. That last
  change is what unblocks the evidence chain below it — in the same run, the
  independent checker could rerun nothing and the reporter had to grade every
  step partial.
  A second run, this time on a small 4-bit local model with no thinking mode at
  all, closed three more. **A step is now one changed thing.** That run's plan
  opened with a step that only read nine files and then wrote three independent
  document sections in one go; the planner is now told that reading is how a plan
  gets written rather than work an implementer can be given, and that several
  things of the same kind get one step each unless a step says why they cannot be
  done apart. The critic refuses both. **The verdict must agree with the
  findings.** The same run's review reported a blocking defect and still called
  the change ready for acceptance — nothing in the script grades a verdict
  against its own findings, so the verifier now carries the rule that one
  confirmed blocking or should-fix finding means "needs changes". **And the
  plumbing stopped leaking**: coverage gaps that survive the round cap are
  written into the review's prose as ground it did not cover, not under a heading
  copied from the marker that delivered them.
  A third run, same task and same local model, showed that "one changed thing"
  needed one more sentence to bite. The fake reading step was gone, but the plan
  had collapsed into a single step covering all three document sections, and the
  critic accepted it on the ground that the task asked for one new file — reading
  a shared destination as a reason the sections could not be done apart. **A
  shared destination file is not that reason**, and both planner and critic now
  say so: sections appended to one document are separate work with separate
  evidence, and combining is justified only when one part cannot be written until
  another exists.
  That run split the plan again, and a review of a document carrying three
  planted false claims returned "needs changes" against its own two confirmed
  findings. It also exposed three more ways a weak model keeps its own rules
  while defeating them. **A closing verification step is a step that changes
  nothing** — the plan ended with an "integrity pass" that only re-ran what each
  step's own verification already proves, and the critic let it stand, so both
  roles now say the plan ends with the last step that changes something.
  **The inventory does not decide what belongs to the review**: it saw a real
  structural defect in the reviewed file, judged it a different kind of problem
  than the operator asked about, and wrote it in prose around the returned
  document, where no later stage reads it — everything noticed now gets an id,
  with the doubt written inside that entry. **And a claim the sources cannot
  settle still gets a question**: the document asserted a measured per-call cost
  no source can support, and it drew no question and no declared limit, so the
  review reported ground it had never checked.

- **`requirements-grill` lets its agents search, and ripgrep is no longer a
  requirement of this package.** The workflow used to run one `rg` itself before
  spawning anything: it picked up to five keywords out of the operator's request
  against a hard-coded list of English stop words, searched a hard-coded ordering
  of directory names, and handed the matching lines to three children that held
  no tools at all. The keyword guess was worse than the search an agent performs
  with `grep`, `find`, `read`, and `ast_index`; it silently returned the wrong
  lines for a request written in any other language; and it was the only reason
  `rg` had to be on `PATH` to install this package. That line is gone from the
  requirements in `README.md`.
  The participants are now declared once in a frozen `GRILL_AGENTS` roster —
  `scout`, `challenger`, `synthesizer` — each entry carrying what the agent
  receives, what it returns, and its capabilities. The first two hold the same
  bounded read-only tools every `plan` stage already had, under host-enforced
  `readOnly: true`; the third holds none, because it only composes the two texts
  it was handed. No stage gains shell, write, or edit. What is given up is that
  the search is no longer byte-for-byte reproducible: coverage now depends on the
  model, and what compensates is that the challenger reopens the files the scout
  named instead of trusting them. Nothing in this workflow loops or branches, so
  no stage declares an answer shape — there is no decision for one to carry. The
  new `requirements-grill-pipeline.svg` shows the three agents and the text that
  passes between them.
  The workflow also stops capping the request's length. It used to refuse
  anything over 12,000 characters, while the run command and the workflow tool
  both already refuse anything over the host's own input limit. A stricter second
  number in the entry could not protect anything the host's bound did not already
  cover — it could only turn away a request the operator was allowed to send. An
  empty request is still refused before any child is spawned. `plan` lost the
  same check for the same reason, with one difference: its number was a copy of
  the host's rather than a stricter one, so nothing could ever reach it.

- **`plan` is now three named agents and one loop, and it never stops to ask.**
  The workflow's participants used to exist only as `agent()` calls inside async
  functions, labelled with verb phrases; a reader could not list the cast without
  following the control flow, and the names on its diagram matched no identifier
  in the source. They are now declared once in a frozen `PLAN_AGENTS` roster —
  `scout`, `planner`, `critic` — each entry carrying what the agent receives,
  what it returns, and its capabilities, with the call sites spreading those
  options and adding only the round label. The redrawn `plan-pipeline.svg` shows
  the same three agents and the text that passes between them.
  The operator-clarification round is gone with everything that supported it: no
  clarifier stage, no operator pause, no continuation into a second run. When the
  task leaves a real choice open the planner records it in the plan under
  `## Assumptions` as "assumed X, because Y; wrong if Z" and plans on it, and the
  critic counts a decision the plan depends on but never states as a defect while
  a stated one is not. A halted run yields no plan at all; a written assumption is
  visible when the run finishes and is corrected by replanning.
  `plan-implement` no longer re-derives the host's continuation proof. It still
  requires exactly one non-empty `plan.md` reference, but the digest, target,
  stage, and terminal-result checks are gone. That trade is deliberate and it is a
  real one: the removed check is what distinguished the accepted plan from a
  same-named draft of an earlier round, so a run can now implement a plan the
  critic had not accepted. The cost of the ceremony — on every reader of the
  entry, and on every weaker model asked to author something like it — was judged
  higher than a failure replanning repairs. The plan is no longer length-capped
  either: a cap there could only reject a plan somebody had already accepted,
  after the run that wrote it had finished, and the per-step budgets are what
  actually keep one writer's prompt in hand.

### Added

- **The package now ships an architecture decision record for the six ownership
  layers under `extensions/_shared/`.** `AGENTS.md` already stated the rules a
  contributor must obey and `scripts/check-extension-layers.ts` already enforced
  them, but nothing said in prose what the six layers are for, which modules live in
  each, or why the declared order is the order it is.
  `docs/adr/extension-ownership-layers.md` records all three: the forty-three shared
  modules by layer, the rank order and the operator layer's narrowing in both
  directions, the one sanctioned read-only door into workflow run persistence with
  the two modules outside the workflows extension that use it, and the alternatives
  that were considered and rejected.
  **It also records the two failure modes the static check structurally cannot
  see,** which is the reason the boundary is a script rather than a convention. A
  path a module derives from its own file location silently repointed at a
  directory that does not exist twice during this breakup, and the check reported
  zero violations both times. A process-global registry that becomes
  per-module-instance state stays typecheck-clean and statically green, because Pi
  loads each registered entrypoint with the module cache disabled — only a test
  that loads two entrypoints in one process can see it. Six of the seven declared
  registries carry such a proof today, and the ADR names the seventh as still
  lacking one rather than implying the set is complete. No source module moved and
  no guardrail rule changed.
  **Writing it down found two statements this breakup had already shipped that were
  no longer true.** The read-only door's own header justified keeping one path
  derivation in place because three modules that use it were still in
  `extensions/_shared/`; a later slice moved all three into the workflows extension,
  which makes that edge ordinary, so the header now says the ownership objection has
  lapsed and gives the cohesion reason that still holds. And an entry above
  overstated how often the self-derived-path hazard had struck, counting three
  occurrences where there were two. Both are corrected here rather than left for a
  reader to trip over, because a boundary is only as good as the description someone
  reads instead of the code.

- **Reading a workflow run from outside the workflows extension now goes through
  one read-only door, and nothing can reach past it.** The module that owns
  `.pi/locus-pi/workflows/<runId>/` also owns the append sink, the
  journal-to-live-row projection and the live-row retention bound. Two consumers
  only ever needed to _read_ a run — the agent drill's round submenu and the
  loop's continuation source — and both imported that module directly, so both
  held its write side as well. `extensions/workflows/run-read.ts` is the surface
  they get instead: the read operations and the one type those return, and nothing
  else.
  **Nothing was reimplemented behind it, and that was the evidenced choice rather
  than the lazy one.** A read operation is worth relocating only when it is
  self-contained, and none of these is. The live-row id parser is called by the
  journal's own retention pass, which then clears the retired runs' writer entries
  from a process-global map; the run-directory path builder is still used by three
  sibling modules inside `_shared/`. Relocating either would have made
  foundational shared code import a feature directory — the one edge the ownership
  refactor exists to remove. The run listing, the journal read, the run summary and
  the two round readers all resolve through private journal internals: the
  start-timestamp proof that orders runs, the per-line structural validator that
  separates valid rows from diagnostics, and the persisted-result disposition
  projection. Copying any of them across would have forked a parser away from the
  format it parses, and splitting a function from the global state it reads is how a
  relocation silently ends up with two live-state slots. Facade purity was worth
  less than either.
  **A ninth check keeps the door from becoming decorative.** `npm run check:layers`
  now accepts a declaration that a module is internal to one extension plus the one
  facade file that stands in for it everywhere else, and rejects any import of that
  module from another extension directory. The existing no-upward-import rule was
  about direction — shared code may not reach up into a feature — and said nothing
  about two features being peers, so without this the next edit could import the
  journal from `extensions/agents/` again and the facade would sit there unused.
  Tests are deliberately out of scope: a test of the journal has to import the
  journal, or it is testing the facade while the internals go uncovered.
  **The loop's continuation helper moved to the extension that owns it.**
  `extensions/_shared/loop-continuation.ts` is now
  `extensions/loop/loop-continuation.ts`. Its only importers were three files in
  `extensions/loop/`, and it read the workflow journal — so had it stayed in
  `_shared` while the facade landed, a shared module would have been importing a
  feature directory, which is exactly what the new check forbids. Moved, the same
  dependency is a legal edge from one extension to another's declared facade.
  Behavior is unchanged throughout: run listing, round lookup, continuation
  creation and the refusal for an absent run all do what they did before.

- **`extensions/_shared` now has a declared owner per module, and the import
  direction is checked instead of assumed.** The directory had grown to 64 modules
  with no stated boundary, so nothing distinguished a genuinely shared primitive
  from a single-extension helper that landed there by habit — and nothing stopped
  foundational shared code from importing a feature entrypoint, which is the edge
  that makes a shared directory unsplittable. `npm run check:layers` (also inside
  `npm run check`, so the existing push gate runs it) reads a ledger that classifies
  every shared module exactly once, either into a named layer or with the extension
  directory it is scheduled to move to, and fails on: an import that escapes
  `_shared/` into a feature directory; an import that points up the declared layer
  order, type-only imports included, since a type edge encodes ownership just as
  much as a value edge; a new shared module with no declared owner; a module deleted
  from `_shared/` without landing at its declared destination; and a module sitting
  in a layer subdirectory that contradicts its declared layer. The operator UI layer
  is a leaf in both directions — it may reach only the host layer, and no other
  shared layer may reach it, because a foundational module that depended on it would
  drag command registration and rendering down into the base of the tree.
  **Two kinds of process-wide state are tracked separately, because only one of them
  is findable.** Versioned `globalThis` slots (`Symbol.for("locus-pi.…")`) each get
  exactly one declared owning module — two modules naming one slot is precisely how
  a file move splits live state that separately loaded Pi entrypoints are supposed
  to share. Mutable module-level state that is _not_ such a slot cannot be found by
  that sweep at all, so it is declared by hand and the check also rejects a new
  mutable exported container in `_shared/`; that state does not survive Pi loading
  two entrypoints with the module cache disabled, and a relocation must not quietly
  imply that it does.
  **Two imports that already point the wrong way are named rather than tolerated.**
  A host-layer module value-imports a constant from the provisional catch-all
  module, and another host-layer module imports the runtime-layer session stores it
  probes for. Both are recorded as declared exceptions with the slice that clears
  each, and the check fails as _stale_ once an exception stops being needed — so the
  rank order becomes real by subtraction instead of quietly staying loose.

- **`agent({ attempts })` — a bounded retry for the failure where the child never
  got to answer.** A dropped child session or an expired turn budget ended the whole
  run, and an author's only recourse was to re-run the pipeline from the start. That
  is now a declared, bounded, evidenced retry — and it is deliberately the narrow
  one. It re-sends the **identical** prompt, because there is nothing to repair: it
  never re-asks a child because its prose was thin, and it never touches the
  pre-existing value repair (`schema` plus `validate`), which owns the opposite case
  — the child answered, off-shape. The canonical doc now carries both loops in one
  table with the failures each one owns.
  The retry keys on a **machine-readable cause**, not on the wording of an error
  message. `status` was a four-way split in which a turn timeout, a tool-call budget
  breach, a provider error and any mid-turn throw all arrived as one `failed` plus an
  English sentence, so a predicate over that sentence would have started retrying a
  reworded string's worth of causes the day someone edited one. Every non-completed
  child run now carries a closed, exhaustive cause set where the cause is known,
  through the run envelope and the bridge onto `agent_end`. Exactly two members are
  retryable — the host turn budget and the call's own `timeoutMs` fuse — and a cause
  nothing has shown to be transient reads as `unclassified` and fails closed. A
  result written before the field existed reads as `unclassified` too, so nothing
  starts retrying by accident.
  `attempts` defaults to 1, is capped at 3, and is **refused rather than clamped**
  outside that range, before any child starts. It is also refused unless the call can
  provably not have written — `readOnly: true`, or a `tools` allow-list drawn only
  from the host's read-only set — because a child that timed out mid-edit may already
  have changed the repository, and a second attempt would double-apply. Replay
  eligibility alone is not that proof: `workspaceMode` defaults to `"project"` and a
  catalog agent stays write-capable unless the call says otherwise.
  Every physical attempt is a real agent call and is billed as one: its own `callId`,
  its own transcript and result envelope, its own charge against
  `maxTotalAgentInvocations`, and its own `agent_start`/`agent_end` pair carrying
  `attempt`, `attempts` and the `logicalCallId` of the call they belong to. The
  reader's copy under `.locus-pi/<runId>/` grows a `## Retried agent calls` section
  naming every attempt and the discarded one's cause, grouped by that logical call —
  `parallel()` can run two calls that agree on agent, label, phase and group, and a
  report grouping by those would put one call's discarded attempt under the other.
  An attempt that **throws** has no `agent_end` at all — an unavailable agent SDK
  substrate leaves no channel to re-ask on, so the call throws and the run ends. Its
  typed cause and its attempt fields travel on the terminal `error` line instead, and
  the report reads that line too, so a retry already spent stays visible when the next
  attempt is the one that ends the run.
  Resume is unaffected by construction: the replay envelope opens once per **logical**
  call and every physical attempt inside it shares that one ordinal, so a retry cannot
  shift a later call's position, and `attempts` stays out of the canonical request so
  recordings written before it existed still replay.
  The persisted `locus.agent.run-result.v1` envelope carries `failureCause` too, so the
  durable per-call record and the run journal name the same cause instead of one of them
  leaving a reader to match on English. Where the workflow's own per-call `timeoutMs`
  fuse fired, that classification is the one written down: the host honestly reports the
  cancellation it observed, and only the caller knows it pulled the trigger.

- **One package budget contract, so a workflow run is bounded on every axis the
  host can enforce without the script saying anything.**
  `DEFAULT_WORKFLOW_BUDGET` in `extensions/workflows/runtime/workflow-budget.ts` is now the
  single source for global agent concurrency (4), total agent invocations per run
  (200), run wall clock over the agent chain (2 h), per-child wall clock (10 min),
  per-child tool calls (1000), per-child turns (5) and answer characters
  (500 000). Before it, two of those numbers lived 580 lines apart in the runtime
  with no cross-reference, global concurrency had no default at all — a nested
  fan-out of four branches of three really did run twelve children at once — and
  no run had a wall clock. The runner applies the whole contract to every run, so
  a script that declares nothing is still bounded; a stage may still narrow any
  per-call axis, and a raise is written to the journal naming the axis, the
  default and the requested value rather than applying in silence. Two axes are
  reported and deliberately not enforced: token counts are printed when the host
  supplies them, and cost is printed as unavailable, because `costTotal` is still
  a hardcoded `0` and a limit over a stub reports "under budget" forever.
  `maxTurns` becomes an ordinary `agent()` option within the host clamp of 1..20,
  and `timeoutMs` is capped at 2,147,383,628 ms so neither the workflow fuse nor
  its derived SDK backstop crosses Node's timer limit and collapses to an
  approximately one-millisecond delay. The run's
  `.locus-pi/<runId>/README.md` gains a `## Budget` section showing
  every axis with its applied value beside the spend the run evidence can actually
  measure — the axes it cannot measure print as "not recorded", never as `0`.
  **Two consequences worth knowing before upgrading.** Recorded runs made before
  this release are no longer replayed: `timeoutMs` is part of the canonical
  request by design, so a record written while the axis had no default describes a
  different call once it has one. Those children were not unbounded — the SDK host
  has always stopped one at its per-turn timeout times `maxTurns`, which with the
  values in force was the same ten minutes — but the bound was the host's, not a
  declared workflow fuse, so it never named the axis and was never part of the
  replay key. Reusing such a record would serve text produced under an implicit
  host ceiling as though the declared fuse had been in force. Records live in
  ignored per-workstation state, so the cost is a re-run, not lost work. And the
  run wall clock is checked when a child starts, which bounds the agent chain: a
  run is bounded by `runtimeMs` plus at most one child's own `timeoutMs`, and
  script code that calls no further agent is not bounded by it at all.

- **A shipped skill, so an agent can find the workflows the package already
  installs.** The six Package workflows resolve out of the installed package and
  need no copied files, but nothing in a fresh session said what a "workflow" is
  here, which names exist, or how to read a finished run — so a weaker model
  asked to run one went looking for a source repository that is not on the
  machine. `skills/locus-pi-workflows/SKILL.md` is now declared through
  `package.json#pi.skills`, which Pi discovers and enables automatically, so its
  description sits in the system prompt from the first session and the full text
  loads on demand or through `/skill:locus-pi-workflows`. It covers the catalog and
  run commands, the result envelope and artifact locations, the four-step name
  resolution order, every member of the handle a workflow is given, an authoring
  template with a shaped stage and the rules that decide whether a new file runs
  at all, and the trust boundary stated as it is: the package does not sandbox
  workflow code. Two tables send the reader to the shipped examples by exact
  path — one for what each workflow is for, one for the technique each entry
  file is the smallest place to see — so an agent copies a working shape instead
  of inventing one. A package-boundary test pins the
  declaration to the shipped file and fails when the skill points at a document
  the tarball does not contain, because a reader who arrived lost cannot afford
  a dead link.

- **Two Package workflows for planning and implementation: `plan` and
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
  Both live in `extensions/workflows/examples/`, which is the Package registry, so
  `/workflow-run plan` and `/workflow-run plan-implement` resolve without any
  project file, and both ship in `package.json#files` and
  `public-repository.json` with the diagram triple every workflow there carries.
  That directory is also the only route to a workflow that is both tracked in the
  repository and resolvable by name: every other directory the resolver scans —
  `.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/` — is git-ignored,
  so a copy placed there works on one machine and exists in no clone. The current public portfolio is listed in
  [`docs/workflows.md`](docs/workflows.md).
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

- **The Package workflow registry is now the shipped `extensions/workflows/examples/`
  directory itself, not a hand-maintained allowlist.** Every
  `<name>.workflow.mjs` in it resolves through `/workflow-run <name>`, discovered
  on each call exactly like a project directory, and
  `CURATED_PACKAGE_WORKFLOW_NAMES` is gone. Registering a workflow used to mean
  editing a constant, a relative-path map, the package allowlist, the
  public-repository inventory, six test files, five manuals, the support
  boundary, and an ADR — for a change whose entire content was "this file is
  runnable by name". The bookkeeping that merely duplicated the filesystem is
  what was removed; everything that describes a public surface stayed.
  Two bounds keep the scan honest: it descends one directory level, so a workflow
  keeps its prompt resources and diagram triple beside its entry while support
  material nested deeper is never mistaken for an entry point, and it accepts
  only regular files, so a symlink never resolves out of the package. What an
  install ships is still `package.json#files`, and the package-boundary test now
  asserts that the packed workflow names equal the names the directory resolves —
  a workflow added to the directory and not packed fails the build instead of
  working in a checkout and vanishing after `npm i`. The same test keeps a
  reviewed snapshot of the expected names, so adding or removing a file there
  still fails until a human looks at it.
  `excalidraw-pipeline` moved to `extensions/workflows/references/` as part of
  this: it was documented as "reference only, do not run it by name", and under a
  scanned registry that is a location, not a note. The current public portfolio is listed in
  [`docs/workflows.md`](docs/workflows.md).
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
  `.pi/locus-pi/workflows/<runId>/artifacts/index.json`. Every `agent()` attempt
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
  root through `.pi/locus-pi/workflows/<runId>` before reads and writes, so a
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
- Recorded the strict curated-workflow selection criteria and candidate boundary;
  the current public portfolio is listed in `docs/workflows.md`.
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
  into `live-smoke`; see the current public portfolio in `docs/workflows.md`.

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
