# Changelog

User-visible changes to the public package.

## [Unreleased]

### Changed

- Workflow authoring now has one short router and four explicit forms: fixed graph, bounded refinement, bounded decomposition and split-run human continuation. The source checker admits narrowly bounded whole-value carry and author-owned record fields without making model output inspectable. Runnable examples and negative contract fixtures accompany the change.
- Opt-in `agent({ returnVia: "tool", choice })` or a closed string `output` uses a workflow-only `workflow_return` tool. Invalid/missing submissions receive bounded clarification in the same child session; cumulative child budgets, cancellation and provider failures remain authoritative. Legacy exact text and fresh-session schema repair keep their existing behavior.
- `parallel(thunks, { concurrency, keys, title })` accepts explicit local width and full business-key identity while retaining the global leaf-agent gate and input result order. Agent titles, branch-local phases and distinct queued/start journal events improve inspection. The structured workflow tool exposes the existing shared budget and records validated/fallback choice origin.
- Explicit `recoverInterrupted` adds conservative admission for a fully confirmed serial prefix after missing terminal publication, using root launch bindings and strict replay. It refuses uncertain effects, changed input/source/budget, grouped execution and corrupt results; ordinary Repair + Continue is unchanged. This is not an exactly-once side-effect guarantee.

- Запуск workflow теперь имеет одну общую папку с README и ссылкой на workspace: saved children находятся в `children/<runId>/`, попытки resume — в `attempts/<runId>/`. Workspace получает обратные ссылки в runtime-owned `.workflow-runs.md`. Каждый execution сохраняет отдельный ID и receipt; status, artifacts, replay и resume находят вложенную и прежнюю flat историю без миграции. Независимые запуски одной session не объединяются, а `lineage.rootRunId` сохраняет смысл root текущей попытки.
- Список истории включает root, attempts и saved children, а `last/latest`, loop source и stop completions игнорируют saved children. README группы и workspace backlink пишутся атомарно и durable только под root lease.
- TUI selection now has one documented visual language. Horizontal source, provider, and action choices use the same high-contrast purple fill; interactive `SELECT` blocks use a purple-family frame; and `/model-roles` moves one strong focus from model to role to effort instead of leaving several selected rows on screen. Saved assignments remain green, warnings remain yellow, and plain hosts retain brackets and cursor markers without ANSI.
- Saved workflow names now resolve only from the nearest project `.locus-pi/workflows/`, then user `~/.locus-pi/workflows/`, then Package. The old `.pi/workflows/`, `.claude/workflows/`, and `.agents/workflows/` directories no longer participate in saved-name discovery. Catalog copy, authoring guidance, persisted source validation, and generated-workflow handoff now use the same canonical root; existing old files are not deleted.
- A workflow that stopped at one node can now be repaired in the same file and continued from that node. `--resume <runId>` (tool: `resumeFromRunId`) no longer requires unchanged source bytes: the nodes that already completed return their recorded answers and do not execute again, while the repaired node and the tail after it run fresh. Each recorded agent call carries a `node` name — `[phase, label, occurrence]` — so the run's `runtime/replay.ndjson` says which nodes finished, and the `replay` envelope of `result.json` adds `divergedAtNode`, the node where continuation became fresh. The refusal that used to fire whenever the source bytes differed is gone from the reason list; instead a call the record cannot name, or that the author never labeled, misses with `unnamed-node` and takes the rest of the run with it. Any miss now ends reuse for the remainder of the run, which also means a `fusion()` group standing after that point ends the run with `fusion resume cannot mix recorded and fresh agent calls` instead of running a fresh panel, and a byte-identical resume no longer replays a fusion tail that stood after a recorded failure. The strict `orchestration-only` source check now requires every `agent()` call to declare a unique literal `label`, and the workflow-run skill's recovery procedure has two outcomes, `continue` and `refuse`.
- Project-local locus-pi data now has one readable layout: workflow workspaces use `.locus-pi/workspaces/`, authored `/plan` documents use `.locus-pi/plans/`, run evidence stays under `.locus-pi/runs/`, and saved-child checkpoints stay under `.locus-pi/workflow-state/`. Existing named workspaces keep their old physical path and checkpoint identity; conflicting old/new paths fail closed. Legacy home plan files migrate by verified atomic copy and are never deleted automatically.
- New workflow `result.json` envelopes no longer duplicate the full journal. They keep bounded typed finalization errors for late failures that must survive a best-effort journal write. Live operator answers are indexed, digest-verified run artifacts, and an evidence write failure aborts the child call instead of returning an unrecorded answer.
- Manual workflow loop continuation now returns the exact continuation prompt directly and no longer writes a separate `.locus/runtime/loop/workflow/*.json` file.
- Model roles now have one persistent authority: `~/.pi/agent/model-roles/config.json`. `/model-roles` reads and writes that global user file. Project `.pi/model-roles/config.json`, `settings.json#modelRoles`, and session evidence no longer override it.
- The Package `task` namespace now has one explicit handoff: `task/draft` publishes an editable brief with the graph pattern, agents, handoffs, review bounds, concurrency, failure exits, and primary output; `task/plan` consumes the accepted text and directly publishes a checked `workflow.mjs`.
- The workflow-create skill now authors orchestration-only JavaScript. New workflows may contain visible prompts, agent calls, DSL control flow, and text publication, while project inspection and file work belong to child agents instead of workflow-side file, path, or artifact-reading primitives. Its Build step uses a strict `workflow_check_source` mode; the default compatibility mode still validates existing reviewed workflows.
- Escape from an agent drill opened through `/ps` now returns to `/ps` on the row it was opened from instead of to the editor, and the fleet re-reads its membership on the way back, so agents that arrived during the drill are there. `q` still leaves the agent surface for the editor, and a drill whose row retired while it was open hands the editor back rather than reopening a fleet nobody asked for.
- The workflow progress panel below the editor now shows the run tree instead of a flat list of agents. A fan-out contributes its group heading with the `k/n done · f failed` counters `/ps` already showed, its members read working first, then failed, queued and done, and a group of one keeps its agent and drops the redundant heading. Both surfaces run the same projection, so a run looks the same in the panel and in `/ps`; only the panel collapses anything, because in `/ps` every leaf has to stay reachable by the cursor. Declared stages the run has not reached yet now share one `○ next: <title> (+k planned)` line, unless a single stage is left and keeps its full reading.
- Agent and workflow live trees now draw full recursive branch rails (`├─`, `└─`, `│`) through group, agent, latest-message, and tool-activity lines instead of flattening every child to `↳`.
- The agent screen opened by `/ps` or `/agent drill` now says where the agent is and whether it is alive. Its header names the workflow run, the stage, the enclosing group and the agent, read from the live rows and the run journal rather than from anything the agent wrote; beneath it one status line carries the state icon and word plus how long the work has been running, refreshed once a second and frozen with the rest of the surface in calm rendering. The footer drops `STATUS:` and carries controls only. A row outside a workflow keeps its short one-line heading.
- The agent screen no longer turns on terminal mouse tracking in Pi's regular mode. The wheel and the host terminal's own scrollback stay with the terminal, and the screen's history moves on PageUp/PageDown/Home/End. `LOCUS_DRILL_MOUSE=1` restores the previous wheel capture, and the footer offers `wheel` only where the screen captures it. In Pi fullscreen the screen writes no mouse sequences at all and leaves wheel reports to Pi; a host that supplies a terminal wrapper without a mode is treated the same way, so the variable has no effect there. In fullscreen the history keys are consumed by Pi's own viewport before any component sees them, so the footer there promises no history control at all rather than a key that does nothing.
- The reply box on the agent screen is now Pi's editor component mounted whole, with its own frame and its own key hints, instead of four of its parts with a hand-written `↵ send` hint that named keys an operator's keybindings may never have had. That costs height: the smallest terminal that still offers input is 18 rows rather than 9, and below it the screen says `resize terminal for input`. Once the editor is on screen it is not taken away mid-sentence — the body gives up its rows first.
- A workflow now refuses a second `agent()` call that would occupy a `(phase, label)` slot another call of the same run is still executing, and the refusal names the phase and the label. One slot is one live row and one journal correlation key, so two concurrent occupants collapsed two branches into a single line. Sequential re-entry of the same slot — the loop round `r<N>` — is unaffected; the claim is released on failure, abort and run deadline alike; and a call without a label anchors no slot.
- Mapped `parallel()` and `pipeline()` members can now invoke the same labelled `agent()` callsite concurrently. Each member receives a runtime-owned live-row occurrence, while authored phase/label values, sequential rounds, replay node identity, and the refusal for true duplicate callsites stay unchanged.

### Fixed

- A fan-out's group heading now counts up while the run is still going. The heading read its `k/n done · f failed` from fields the journal writes only when the group ends, so a nine-member fan-out sat at `0/9 done` until it settled, next to a panel header that was counting correctly. Both surfaces now fold the members' own states into the heading, and a group that reported its own final numbers still wins.
- The group heading no longer disappears from `/ps` once a fan-out is taller than the list's window. The window was anchored on the cursor, and only members take the cursor, so the heading fell out with no key able to bring it back. The nearest heading is now pinned above the window without costing a member row.
- Home and End work on the agent screen in every terminal. The screen matched only the bare key names and one of the three encodings a terminal may send, so in a multiplexer pane both keys did nothing while the manual promised them.
- The agent screen keeps its footer in Pi fullscreen. At full height the screen asked for every row but Pi's status line, and the transcript view refused to give up its last row, so the line carrying `esc close` was clipped off the bottom. Fullscreen now buys the footer with one line of transcript.
- The `message queued` notice no longer outlives the child that could have answered it, and the footer offers the wheel wherever the screen actually captures it rather than only beside an open reply box.
- At normal interactive heights, `/workflows list` now keeps its Project, User, Package, and History tabs at one stable position below the heading instead of moving them with source content height. The existing few-line compact projection is unchanged. Wherever tabs are shown, the active tab has a high-contrast purple background. Parent descriptions now start one column to the right of the child's `└` branch, so each description remains visually attached to its parent.
- A failed run's diagnostic now points at the failing stage's answer file with a path that opens. It was built by joining the artifact's own relative path onto the run directory, which dropped the `runtime/artifacts` segment and produced a pointer to a file that does not exist.
- Live workflow rows no longer fall off the progress panel once finished fan-outs fill it. The roster used to collapse the first settled entry, which a group heading never was; with nothing left to collapse it cut the tail instead and took the running group, its working agents and the pending stage line off the panel, while the finished rows stayed. It now gives up the most expendable settled entry first, so working rows and a live group's heading survive, and a collapsed heading is announced as `(+N earlier groups)` instead of disappearing.

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
- A workflow run starting in the same second as another run could crash with `EEXIST` instead of starting — most visible on `--resume` right after a short run, when both drew the same random run-id suffix. Run-id allocation now serializes global discovery, reserves the execution directory, initializes its journal, and retries fresh ids on collision; resume ids are never re-minted.

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
