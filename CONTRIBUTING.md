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

`npm run check` is the canonical gate. One command, deterministic and read-only by construction — it formats nothing, generates nothing, and leaves the working tree byte-identical — and it needs no network beyond the npm cache `npm ci` already filled. It reproduces every check CI can run against this source tree, so a green `check` locally and a green CI mean the same thing.

| Command              | Composition                                                                                              | Use it                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run check:fast` | manifests, layers, workflow source shape, typecheck, Pi host version, tests, source audit                | while editing; deliberately not release-complete             |
| `npm run check`      | `format:check`, `check:links`, `check:generated`, then `check:fast`, `check:repository`, `check:release` | before every commit and pull request, whatever the change is |
| `npm run check:push` | `check` plus the dry-run pack contract                                                                   | run for you by the tracked `pre-push` hook                   |

On an Apple-silicon laptop `check:fast` takes about 17 seconds warm — 27 on the first run after `npm ci` — and `check` about 21. The four extra gates cost a few seconds, not a longer test suite, so reach for `check:fast` only inside a tight edit loop.

Three steps stay outside `check` because none of them checks this source tree deterministically: the dependency audit needs the registry, and the doctor and the pack candidate exercise the installed host and npm itself. CI runs them after `check`, and so should you before a release:

```bash
npm audit --omit=dev
./bin/locus-pi doctor
npm pack --dry-run --json --ignore-scripts
```

Docs-only changes run the same `npm run check`: `format:check` and `check:links` are inside it. The pre-commit hook adds `git diff --check` on staged content.

`check:generated` occupies the slot between `check:links` and `check:fast`: it regenerates the public catalogs into memory and fails when a committed byte differs. Two enumerable sets are machine-owned — the extensions `package.json#pi.extensions` activates and the workflow names `extensions/workflows/examples/` resolves — and both are written by one generator into `dist/public-catalogs.json` and into the fenced regions of `README.md`, `docs/extensions.md`, and `docs/workflows.md`.

Never edit between a `<!-- locus:extensions:start -->` or `<!-- locus:workflows:start -->` marker and its `:end` partner. After adding or removing an extension entrypoint or a packaged workflow, run:

```bash
npm run build:catalogs
```

Then commit the regenerated artifact and documentation with the change. The prose outside the markers stays hand-written; only the enumerations and their counts are generated.

## Change expectations

- Keep the change bounded and explain the user-visible outcome.
- Add or update focused tests for runtime behavior.
- Keep source, manifests, co-located manuals, package inventory, and public-repository inventory aligned.
- Add a concise entry under `CHANGELOG.md#Unreleased` for user-visible package, behavior, documentation, security, or support changes.
- Do not commit credentials, auth files, private runtime state, task drafts, generated reports, transcripts, evaluations, or absolute workstation paths.
- Do not change repository visibility, branch protection, publication credentials, or legal metadata without owner authorization.
