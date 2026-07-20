# locus-pi development contract

## Repository roles

- `main` is the stable release branch and the default GitHub branch.
- `dev` is the integration branch for accepted task and milestone work.
- Historical private migration sources are evidence only, not active development targets.
- `.locus/`, `.tasks/`, generated reports, credentials, and workstation-specific state remain local and must not be committed.

## Branch and pull-request policy

1. Start each task or milestone branch from the latest `dev`.
2. Open normal pull requests into `dev`. Do not push directly to `dev` or `main`.
3. Squash-merge normal pull requests after CI and review are complete.
4. Release only through a pull request from `dev` into `main`.
5. Merge release pull requests with a merge commit, then create the matching `vX.Y.Z` tag.
6. Keep `main` as the GitHub default so visitors land on the stable release surface.

This repository is public, so GitHub branch protection and rulesets are available on the current plan — but neither is configured. `main` and `dev` both report `protected: false` and the repository has no rulesets, so the rules above are currently enforced only by the tracked pre-commit and pre-push hooks, CI, and review discipline. Those hooks are local and skippable (`--no-verify`, an unhooked clone), which makes the boundary a convention rather than a server-side guarantee. Enabling branch protection or a ruleset on `main` and `dev` — for example requiring pull requests and the `Node 22 package contract` CI check — is an owner decision and an explicit repository-settings change; agents must not make it.

## Local setup

Use Node.js `>=22.19.0`, install exact dependencies without lifecycle scripts, and activate the tracked hooks:

```bash
npm ci --ignore-scripts
npm run hooks:install
```

The pre-commit hook formats supported staged files, checks staged whitespace and secrets, runs TypeScript validation, and blocks commits on `main` or `dev`. The pre-push hook blocks direct pushes to `main` or `dev` and runs the full local push gate.

## Validation

Run the narrowest relevant check while developing. Before pushing code or package-boundary changes, run:

```bash
npm run check:push
```

CI repeats source checks, tests, source-audit checks, public-repository inventory validation, dependency auditing, Pi diagnostics, and npm tarball inspection.

## Changelog and release metadata

- User-visible package, runtime, manual, security, or support changes must update `CHANGELOG.md` in the same pull request.
- Routine task pull requests do not bump the package version.
- The release pull request from `dev` to `main` must bump `package.json`, update `CHANGELOG.md`, and pass the release-metadata check.
- Create the Git tag only after the release pull request lands in `main`.

## Public package boundary

- `package.json#pi.extensions`, extension manifests, public manuals, source-audit notes, and `public-repository.json` define the public surface.
- Do not widen the default extension list, curated Package workflow registry, runtime dependencies, or npm allowlist without an explicit ownership decision and matching tests and documentation.
- Never commit or publish credentials, auth files, absolute workstation paths, private runtime state, generated research, transcripts, benchmarks, or evaluation artifacts.
- Repository visibility changes and npm publication remain explicit owner actions.
