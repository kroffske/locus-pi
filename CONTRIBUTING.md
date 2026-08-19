# Contributing

Issues and pull requests are welcome for supported package behavior. Security reports must use the private route in [`SECURITY.md`](SECURITY.md), not a public issue or pull request.

## Branch flow

1. Update local `dev` from `origin/dev`.
2. Create a focused branch from `dev`.
3. Open a pull request into `dev`; squash-merge after CI and review.
4. Release through a pull request from `dev` to `main`, merged with a merge commit.
5. Tag the resulting release as `vX.Y.Z`.

Do not push directly to `main` or `dev`.

## Development setup

Use Node.js `>=22.19.0`. Run the Pi version pinned in the four `@earendil-works/pi-*` development dependencies. The open-ended peer range does not block later host versions; the exact development pin records the version the repository suite has actually exercised.

```bash
npm ci --ignore-scripts
npm run hooks:install
npm run check:pi-host
pi install -l .
```

The tracked pre-commit hook expects `gitleaks` for staged secret scanning.

### Test a newer Pi host

Use the version reported by the actual CLI you intend to support, then update all four Pi development packages and the lockfile together:

```bash
PI_BIN="$(command -v pi)" npm run sync:pi-host
npm run check
```

`sync:pi-host` reads the version from the selected CLI, updates all four Pi development packages and `package-lock.json` together, and then runs the CLI/SDK consistency check. Set `PI_BIN` when the intended host is not the first `pi` on `PATH`.

Do not narrow the peer range to the tested patch or minor version. The exact development version records what was exercised; the peer range records the minimum supported host contract.

## Before changing an extension

Read:

- `README.md`, `docs/getting-started.md`, and `docs/architecture.md`;
- `package.json#pi.extensions`;
- `extensions/<name>/README.md`;
- `extensions/<name>/manifest.json`;
- focused tests for that extension.

Do not widen the default extension list, Package workflow registry, runtime dependencies, permissions, or npm allowlist without matching implementation evidence, tests, documentation, and review.

## Validation

Code or package-boundary changes require:

```bash
npm run check
npm audit --omit=dev
./bin/locus-pi doctor
npm pack --dry-run --json --ignore-scripts
```

Docs-only changes still require source verification, link checks, formatting, and `git diff --check`.

## Change expectations

- Keep the change bounded and explain the user-visible outcome.
- Add or update focused tests for runtime behavior.
- Keep source, manifests, co-located manuals, package inventory, and public-repository inventory aligned.
- Add a concise entry under `CHANGELOG.md#Unreleased` for user-visible package, behavior, documentation, security, or support changes.
- Do not commit credentials, auth files, private runtime state, task drafts, generated reports, transcripts, evaluations, or absolute workstation paths.
- Do not change repository visibility, branch protection, publication credentials, or legal metadata without owner authorization.
