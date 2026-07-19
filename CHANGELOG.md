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
  `fix-plan.md` for human disposition editing. The workflow script performs no
  direct Git, network, forge-specific, or `llm()` work; its local loader reads
  only the package-owned agent manifest.
- Added the curated `review-fix` workflow. It applies only explicit `accepted`
  findings from the review-created approval plan in a retained linked worktree,
  independently verifies the diff, and writes `fix-report.md` without commit,
  push, merge, deployment, or original-checkout edits.
- Recorded the strict curated-workflow selection criteria and candidate boundary
  in `docs/adr/curated-workflow-portfolio.md`.
- Added editable Excalidraw.js pipeline maps and PNG previews for every curated
  Package workflow, with explicit operator, workflow, agent, direct-LLM, decision,
  and persisted-artifact ownership.

### Changed

- Separated `review` and `review-fix` into independent workflow directories,
  with each entrypoint and pipeline diagram beside its owning workflow. Shared
  family documentation, C4 artifacts, and the temporary validated
  `agents.yaml` loader live under
  `extensions/workflows/examples/review-family/`, so remediation no longer
  appears owned by the review entrypoint. The modular entry scripts declare
  `identityCoverage: "entry-only"` because the entry SHA-256 does not bind the
  shared YAML or loader bytes.
- Added `yaml` as an explicit runtime dependency for the shipped review-agent
  manifest instead of relying on a transitive package.
- Hardened curated review completion for large cumulative diffs. Evidence-heavy
  review and adjudication agents now receive the runtime's full 100-call budget,
  while `review.md` records the confirmed target, verdict, new findings, prior
  finding reconciliation, independent checks, and residual risks as explicit
  reader sections.
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
