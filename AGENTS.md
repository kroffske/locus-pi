# locus-pi development contract

## Repository roles

- `main` is the stable release branch and default public landing surface.
- `dev` is the integration branch for accepted work.
- `.locus/`, `.tasks/`, `.pi/`, generated reports, credentials, and workstation-specific state remain local and must not be committed.

## Branch and pull-request policy

1. Start focused work from the latest `dev`.
2. Open normal pull requests into `dev`; do not push directly to `dev` or `main`.
3. Squash-merge normal pull requests after CI and review.
4. Release through a pull request from `dev` to `main`, merged with a merge commit.
5. Create the matching `vX.Y.Z` tag after the release pull request lands.

Repository-settings changes, publication, and credentials remain explicit owner actions.

## Local setup and validation

```bash
npm ci --ignore-scripts
npm run hooks:install
npm run check:push
```

Use Node.js `>=22.19.0`. Pi has a minimum peer floor of `0.83.0`; local development and CI run the exact version jointly pinned in the four `@earendil-works/pi-*` development dependencies and `package-lock.json`. Use `npm run sync:pi-host` to move that tested baseline to the selected installed CLI. The pre-commit hook formats staged files, checks whitespace and secrets, runs TypeScript validation, and blocks commits on protected branch names.

`npm run check` is the canonical deterministic gate — formatting, manifests, layers, workflow source shape, types, Pi host coherence, tests, source audit, published links, repository inventory, and release metadata — and CI runs exactly that one command. `npm run check:fast` is the same minus the repository-wide checks, for the inner loop. Beyond `check`, CI adds only what needs the network or the runner environment: the production dependency audit, the extension doctor, the Pi peer version, and the npm pack candidate.

## Extension ownership layers

`extensions/_shared/` contains the named `host`, `operator`, `runtime`, `model`, `project`, and `agent-runtime` layers. `scripts/check-extension-layers.ts` owns the import-direction and shared-state ledger. Read its header before moving shared modules; update the ledger in the same change instead of loosening a rule.

A shared module may not import a feature directory. Direct feature imports must use an explicitly owned facade. Versioned `globalThis` registries have one owning module.

## Public package boundary

The public contract is defined by `package.json#pi.extensions`, extension manifests, co-located extension READMEs, the packaged workflow registry, focused tests, and `package.json#files`.

- Do not widen the default extension list, workflow registry, runtime dependencies, permissions, or npm allowlist without matching proof and documentation.
- Keep `public-repository.json` and the generated public inventory synchronized.
- Stable public guides live in `docs/`; extension behavior lives in `extensions/<name>/README.md`.
- ADRs, product drafts, source-audit working notes, task state, reports, transcripts, benchmarks, evaluations, and local runtime artifacts are not public documentation.
- Never commit credentials, auth files, absolute workstation paths, private runtime state, or diagnostic exports.

User-visible package, behavior, documentation, security, and support changes must update `CHANGELOG.md#Unreleased`.
