# Changelog

User-visible changes to the public package.

## [Unreleased]

### Changed

- Saved workflow names now resolve only from the nearest project `.locus-pi/workflows/`, then user `~/.locus-pi/workflows/`, then Package. The old `.pi/workflows/`, `.claude/workflows/`, and `.agents/workflows/` directories no longer participate in saved-name discovery. Catalog copy, authoring guidance, persisted source validation, and generated-workflow handoff now use the same canonical root; existing old files are not deleted.
- A workflow that stopped at one node can now be repaired in the same file and continued from that node. `--resume <runId>` (tool: `resumeFromRunId`) no longer requires unchanged source bytes: the nodes that already completed return their recorded answers and do not execute again, while the repaired node and the tail after it run fresh. Each recorded agent call carries a `node` name — `[phase, label, occurrence]` — so the run's `runtime/replay.ndjson` says which nodes finished, and the `replay` envelope of `result.json` adds `divergedAtNode`, the node where continuation became fresh. The refusal that used to fire whenever the source bytes differed is gone from the reason list; instead a call the record cannot name, or that the author never labeled, misses with `unnamed-node` and takes the rest of the run with it. Any miss now ends reuse for the remainder of the run, which also means a `fusion()` group standing after that point ends the run with `fusion resume cannot mix recorded and fresh agent calls` instead of running a fresh panel, and a byte-identical resume no longer replays a fusion tail that stood after a recorded failure. The strict `orchestration-only` source check now requires every `agent()` call to declare a unique literal `label`, and the workflow-run skill's recovery procedure has two outcomes, `continue` and `refuse`.
- Project-local locus-pi data now has one readable layout: workflow workspaces use `.locus-pi/workspaces/`, authored `/plan` documents use `.locus-pi/plans/`, run evidence stays under `.locus-pi/runs/`, and saved-child checkpoints stay under `.locus-pi/workflow-state/`. Existing named workspaces keep their old physical path and checkpoint identity; conflicting old/new paths fail closed. Legacy home plan files migrate by verified atomic copy and are never deleted automatically.
- New workflow `result.json` envelopes no longer duplicate the full journal. They keep bounded typed finalization errors for late failures that must survive a best-effort journal write. Live operator answers are indexed, digest-verified run artifacts, and an evidence write failure aborts the child call instead of returning an unrecorded answer.
- Manual workflow loop continuation now returns the exact continuation prompt directly and no longer writes a separate `.locus/runtime/loop/workflow/*.json` file.
- Model roles now have one persistent authority: `~/.pi/agent/model-roles/config.json`. `/model-roles` reads and writes that global user file. Project `.pi/model-roles/config.json`, `settings.json#modelRoles`, and session evidence no longer override it.
- The Package `task` namespace now has one explicit handoff: `task/draft` publishes an editable brief with the graph pattern, agents, handoffs, review bounds, concurrency, failure exits, and primary output; `task/plan` consumes the accepted text and directly publishes a checked `workflow.mjs`.
- The workflow-create skill now authors orchestration-only JavaScript. New workflows may contain visible prompts, agent calls, DSL control flow, and text publication, while project inspection and file work belong to child agents instead of workflow-side file, path, or artifact-reading primitives. Its Build step uses a strict `workflow_check_source` mode; the default compatibility mode still validates existing reviewed workflows.

### Fixed

- At normal interactive heights, `/workflows list` now keeps its Project, User, Package, and History tabs at one stable position below the heading instead of moving them with source content height. The existing few-line compact projection is unchanged. Wherever tabs are shown, the active tab has a high-contrast purple background, and parent descriptions no longer share the same indentation as child workflow rows.
- A failed run's diagnostic now points at the failing stage's answer file with a path that opens. It was built by joining the artifact's own relative path onto the run directory, which dropped the `runtime/artifacts` segment and produced a pointer to a file that does not exist.

### Removed

- Removed the generic `implement`, plan-template renderers, `task/substep`, and `workflow-creator` Package workflows. The concrete result of the authoring path is now the generated `workflow.mjs`, not another universal execution stage.
- Removed the obsolete `locus-pi-workflow-implement-task` skill; workflow skill sync now owns only create and run.

## [0.6.2] - 2026-08-31

### Changed

- The workflow-run skill now explains how to inspect Pi's available models, persistent settings, hard allowlist, one-process CLI overrides, and project or user child-role assignments. Provider, model, effort, and role choices remain operator-owned; the skill does not prescribe concrete defaults.

## [0.6.1] - 2026-08-30

### Changed

- `post-code-review` now treats proven code-shape defects introduced or worsened by the reviewed change as REQUIRED even when runtime behavior still succeeds. Delete-first contraction, dead surface, fake configurability, duplicated invariant ownership, stale derived documentation, misleading behavior descriptions, and open delete/rewrite/owner moves now block that review gate until remediation and a fresh run; impact remains a separate severity axis, and final QA remains separate.
- Workflow agents may declare `requireModelRole: true` beside an explicit `modelRole`. The opt-in contract refuses an unassigned role before child creation, records the strict request on `agent_start`, and separates its replay identity from ordinary portable role fallback; packaged `post-code-review` uses it for every review child.
- `workflow_check_source` now returns stable compiler-style diagnostics with severity and one-based source spans while preserving the legacy message-only checker API. Non-empty `meta.phases` declarations are checked against literal `phase()` calls; duplicate declarations, case drift, and missing-stage drift fail, while unused declarations and order drift are reported as warnings.
- Global `enabledModels` is now a hard Pi execution allowlist: an explicit `--model` outside the list is stopped before the first LLM request instead of bypassing picker-only scoping. Configured empty, malformed, or unreadable policy fails closed.
- Extension source and tests are now grouped by responsibility under named subdirectories, so large extension roots read as a table of contents without changing entrypoints, runtime behavior, or the npm package boundary.
- Internal package ownership is now reflected by source and test paths: the unreachable replacement-session executor was removed, Fusion was grouped under one owner, the rich question implementation was renamed, and outside workflow consumers now read `hasJournal` instead of raw journal records. The steady-state layer checker gained negative fixtures and explicit topology ceilings for the moved test suites; visible TUI behavior is unchanged.

### Fixed

- A short `/agent drill` transcript now starts directly below its frame header and returns only its real content height instead of pushing the request and result to the bottom with synthetic blank rows. Long transcripts still fill the viewport and keep the same tail-follow and history controls.
- Package-owned SDK child sessions now use Pi's public file-backed session manager under their run/report evidence directory, so workflow and direct-agent children no longer appear in the operator's `pi --resume` catalog while native JSONL/HTML export remains available. Pi's built-in `/export` still requires a materialized operator session with an assistant turn; slash-only workflow export is tracked upstream instead of being worked around with a fabricated turn.
- Fresh workflow completion rows now pair the durable agent identity with the same petname shown in `/ps`. Child JSONL/HTML transcript filenames include bounded stage and petname slugs, HTML exports replace the generic browser title with that identity when possible, and the completion digest points to the shared transcript directory once.
- Workflow completion cards now render one gated Next action beneath the exact result instead of repeating it in the persisted digest. Run separators are presentation-only and fill the live card width instead of stopping at a fixed 64 columns; session/model context keeps the same run identity as plain semantic text.
- `/workflows list` now opens on the current source with the most selectable workflows instead of the first non-empty source; equal counts keep Project → User → Package order, and History is used only when every current source is empty.
- `/ps` now focuses the agent roster already visible below the editor instead of drawing a duplicate list over the workflow panel. The focused roster freezes membership and order for cursor stability, keeps live fields current, and scrolls through every leaf row with explicit earlier/later counts; closing or drilling returns through the normal Pi editor lifecycle.
- The TUI surfaces were aligned after a live design review. A healthy working agent now uses the shared accent tone everywhere instead of the warning tone the progress widget forced, so `/ps` and the widget no longer paint the same agent two colors; the `/ps` cursor is a colored `>` instead of an uncolored `▸`; full-screen viewers (workflow catalog, run viewer) clip to their content instead of padding to the terminal height, so closing them no longer leaves a blank screen; `/agent` renders colored at the live terminal width instead of plain at 80 columns; frames use one rounded glyph set, key hints one `·` separator, and framed headings gained a space before the filler rule; `/model-roles` marks assigned roles green and keeps yellow for unset ones; the completion card gets status tones at render time while its stored text stays plain; long workflow paths are shortened in widget headers so the right-hand hints survive; agent previews strip markdown markers; the `/workflows` palette description is a short phrase; and `skills/.ignore` stops the host from scanning the skills README as a skill at startup.
- Workflow root results, `parallel()` branches, and `pipeline()` stages now classify the same JSON-detached returned outcome: `ok:false`, `partial:true`, and `status: "failed" | "blocked" | "cancelled"` all fail consistently. A direct group value that cannot cross JSON detachment, such as unsupported `BigInt`, a circular value, or throwing `toJSON`, fails separately as a typed group-boundary error while its raw value remains evidence; this is not a fourth returned-outcome kind. This is a one-way compatibility change: those non-JSON-safe direct values and direct group `partial:true` values could previously pass the group barrier and now fail closed; root failure statuses previously completed and now fail; `ok:false` remains failure. Packaged `implement` and `post-code-review` phase declarations now exactly match their emitted phase ids.
- A workflow run starting in the same second as another run could crash with `EEXIST` on the run journal instead of starting — most visible on `--resume` right after a short run, when both drew the same random run-id suffix. Run-id allocation now treats the exclusive journal create as the claim and retries with fresh ids on collision; resume ids are never re-minted.

## [0.6.0] - 2026-08-23

### Changed

- **Breaking:** `loop`, `plan` (`/plan`, `/mode`, `/goal`, `/goal-ai`, `/review`, `/todos`, and the `goal` tool), and `todo-context` (`/todo`, `todo_read`, `todo_write`) are now beta and disabled by default. They still install and load with the package, but register nothing until the project enables them in `.locus-pi/config.json` with `{"beta": ["loop"]}` or for one session with `LOCUS_PI_BETA=loop`; restart Pi after either. Extension manifests gained a required `tier` field, and the extension reference gained a `Tier` column.
- The package no longer ships a global agent-profile catalog. Bare `spawn_agent` and workflow `agent()` calls now start clean children, while explicit names resolve only from project or user profiles; workflow authoring is owned directly by the packaged workflow skill.
- Workflow skills now use the action-first names `locus-pi-workflow-create`, `locus-pi-workflow-run`, and `locus-pi-workflow-implement-task`.
- The public repository now uses Git as its file inventory. The duplicate `public-repository.json` and generated TXT inventory were removed.
- The npm package allowlist now names owned directories instead of hundreds of individual files.
- The root documentation was reduced to this changelog, the README, the license, and the agent development contract. Third-party notices moved to `docs/third-party-notices.md`.

### Removed

- The `security-gate` extension and its `/security-audit` command were removed. It was an audit-only observer that never blocked a tool call; approvals remain owned by Pi.

### Fixed

- Workflow `agent({ choice })` now reads the bare member text (`completed`) and the schema-echo object (`{"type":"string","value":"completed"}`) as that member instead of failing the whole run after two attempts; the attempt's `schemaValidation` records the reading as `coercion`. Observed on `openai-codex/gpt-5.6-luna` running a generated `implement-plan.workflow.mjs`, where the completed step's run was discarded over quoting. The generated step prompt no longer forbids the JSON answer the runtime contract then asks for.

## [0.5.0] - 2026-08-20

### Changed

- Workflow source validation moved into the workflows extension as the read-only `workflow_check_source` tool.
- The package became extension-only. The standalone `locus-pi` executable and unused `devext-doctor` extension were removed.

## [0.4.0] - 2026-08-20

### Added

- Fresh workflow workspaces now use unique paths under `.locus-pi/plans/`.
- `task/draft` captures intent before the separate planning, rendering, and execution stages.
- `workflow-creator` and modular `post-code-review` workflows joined the packaged catalog.
- Generated extension and workflow catalogs now come from the runtime-owned source lists.
- Headless runs gained explicit no-operator behavior and bounded live operator questions.

### Changed

- `/workflows` became the canonical catalog for Project, User, Package, and History sources.
- Folder-owned workflow namespaces gained direct child execution and persisted source identity.
- `npm run check` became the canonical deterministic repository gate.
- The security extension became an audit surface rather than a permission grader.
- Public documentation moved to cross-cutting guides under `docs/` and manuals beside each extension.

### Fixed

- Workflow workspaces, locks, resumes, handoffs, and saved evidence now remain bound to their original run and source.
- Workflow discovery, parsing, completion, and packaged registration now share the same source rules.

## [0.3.0] - 2026-08-10

### Added

- The package gained durable workflow runs, saved child sessions, bounded retries, Fusion, model roles, and operator handoffs.
- Planning became an explicit graph that stops for review before execution.
- The package added workflow authoring guidance, architecture boundaries, source checks, and installed skills.

### Changed

- Agent cards, `/ps`, drill views, and workflow transcripts now share stable identities and calmer terminal rendering.
- The Package workflow registry now comes from `extensions/workflows/examples/`.
- Workflow code and shared runtime code moved under clear extension and shared-layer owners.
- The supported Pi baseline moved to `0.83.0` with an exact development pin.

### Fixed

- Workflow resume, replay, failure reporting, workspace paths, model evidence, and output retention were made deterministic.
- Packed documentation links and real npm-package loading became executable contracts.

## [0.2.1] - 2026-07-17

### Changed

- Added the `task branch -> dev -> main` delivery path, Git hooks, pull-request templates, and CI policy checks.
- Corrected packaged documentation links and manifest evidence.
- Pinned GitHub Actions and excluded local npm credentials.

## [0.2.0] - 2026-07-14

### Added

- Published the first MIT-licensed `@kroffske/locus-pi` package with ten default extensions.
- Added real npm-tarball inspection, entrypoint loading, source tests, and dependency auditing.
- Added third-party attribution and public package metadata.

### Changed

- Limited the npm package to the supported runtime, documentation, skills, and curated workflows.
- Removed beta modules, private state, reports, evaluations, benchmarks, and local executables from the package.
