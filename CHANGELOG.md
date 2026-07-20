# Changelog

This file records user-visible changes to the public package.

## Unreleased

### Added

- Added the curated `review` Package workflow as a question-led agent pipeline.
  Six sequential agents resolve the review scope from the operator's free-form
  request, inventory every changed surface, group the inventory into material
  review units, ask falsifiable questions about them, independently reopen the
  evidence to answer those questions, and publish a readable review package
  whose primary report is `.tasks/<task>/artifacts/review.md`. The workflow
  result is an executive summary. Only confirmed problems become findings, and
  a human edits the report directly instead of maintaining dispositions,
  commit hashes, or snapshots. Workflow-local prompts are ordinary neighboring
  Markdown files containing both stable role instructions and dynamic handoffs;
  exact child text is passed between stages without a model-written JSON
  protocol.
- Added the read-only `ast_index` agent tool. Read-only child sessions that ask
  for it get allowlisted `ast-index` navigation commands executed with argv and
  no shell; `clear`, `watch`, unknown commands, and output-file options are
  rejected, and the index database stays in the user cache directory. The
  review stages that trace code relationships prefer it and fall back to
  `grep`/`find` when the binary or index is unavailable.
- Added the curated `review-fix` workflow as the remediation half of the same
  question-led shape. It takes the human-edited `review.md` path, optionally
  wrapped in ordinary words such as "apply only the P1 items in <path>";
  deterministic code extracts and confines that path and refuses a review whose
  findings the operator deleted. Five sequential agents then resolve the fix
  scope, revalidate every finding against live source and group the survivors
  into atomic fix units, apply those units, verify the working-tree diff by
  rerunning the project's checks, and publish `fix-scope.md`, `fix-units.md`,
  and the mandatory `fix-report.md`. All stages work in the operator's launch
  checkout, because a review often covers uncommitted work, and leave every
  change uncommitted without commit, push, merge, or deployment. There is no fix
  plan, no disposition field, and no hash or snapshot binding.
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
  Package workflow, with explicit operator, workflow, agent, direct-LLM, decision,
  and persisted-artifact ownership.
- Added opt-in session todo auto-continuation: a persisted queue context,
  `/todo run` and `/todo pause`, and one hidden Pi continuation turn after each
  successful queue transition.
- Added atomic `/todo append` batches with `;;` separators and a 20-item limit.

### Changed

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
- Expanded the supported curated Package registry from three workflows to five.
  Generic implementation, release, deploy, and incident workflows remain
  project-local; the narrow review remediation family is human-gated, gated by
  deterministic input validation, and never commits.
- Kept review and fixing as two workflows instead of adding a separate
  `review-plan` run. The review report is itself the approval surface: the
  operator edits `review.md` in place, and remediation stays a separate,
  explicitly started workflow with no write authority carried over.
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
