# Changelog

This file records user-visible changes to the public package.

## Unreleased

### Added

- Added the curated `review` Package workflow as an agent-owned pipeline. A
  target agent interprets the operator's free-form request and proves access;
  independent change and whole-context agents obtain their own evidence; a
  final adjudicator reopens the target and verifies findings; then a publisher
  agent creates a local review task and writes both the complete reader-facing
  `.tasks/<task>/artifacts/review.md` and a mechanically copied, all-pending
  `fix-plan.md` for human disposition editing. Workflow-local prompts are
  ordinary neighboring Markdown files containing both stable role instructions
  and dynamic handoffs; exact child text is passed between stages without a
  model-written JSON protocol.
- Added the curated `review-fix` workflow. It applies only explicit `accepted`
  findings from a deterministically validated review plan in one runtime-owned
  retained linked worktree, independently verifies the diff with the same
  opaque workspace handle, and writes `fix-report.md` without commit, push,
  merge, deployment, or original-checkout edits.
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
  project-local; the narrow review remediation family is human-gated and
  worktree-isolated.
- Kept review and fixing as two workflows instead of adding a separate
  `review-plan` run. The review publisher can copy verified findings into a
  pending approval manifest without three more agent sessions, while immutable
  evidence and the human write gate remain separate files.
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
