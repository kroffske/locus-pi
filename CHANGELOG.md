# Changelog

User-visible changes to the public package.

## [Unreleased]

### Fixed

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
