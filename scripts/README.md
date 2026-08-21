# Repository scripts

Development-time tooling for this repository: the validation gates CI runs on
every push and pull request, plus build, publication, and maintenance
utilities. Nothing here ships with the npm package — `package.json#files` does
not include `scripts/` — so every script may assume a full development
checkout with devDependencies installed and Git available.

TypeScript scripts run through `tsx`; `.mjs` scripts run on plain `node`.
Each executable script is bound to an npm script in `package.json`.

| Script                           | npm script                                     | Role                                        |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `audit-sources.ts`               | `audit:sources` (part of `check:fast`)         | Source-ownership and attribution gate       |
| `build-public-catalogs.ts`       | `build:catalogs` / `check:generated`           | Writes and verifies the two public catalogs |
| `check-extension-layers.ts`      | `check:layers` (part of `check:fast`)          | `extensions/_shared` layer and import rules |
| `check-extension-manifests.ts`   | `check:manifests` (part of `check:fast`)       | Manifest schema and declared-path contract  |
| `check-markdown-links.ts`        | `check:links` (part of `check`)                | Internal links in published Markdown        |
| `extension-manifest-sources.ts`  | — (library)                                    | The one reader of the active manifest set   |
| `check-pi-host-version.mjs`      | `check:pi-host` (part of `check:fast`)         | Pi CLI/SDK version coherence                |
| `check-repository.ts`            | `check:repository` (part of `check`)           | Tracked-tree hygiene                        |
| `check-pull-request-policy.ts`   | `check:pull-request`                           | Branch and release policy for PRs           |
| `check-release-metadata.ts`      | `check:release` (part of `check`)              | Version, changelog, and tag consistency     |
| `check-workflow-source-shape.ts` | `check:workflow-source` (part of `check:fast`) | Packaged workflow source shape              |
| `markdown-links.ts`              | — (library)                                    | The one Markdown link parser both gates use |
| `sync-pi-host-version.mjs`       | `sync:pi-host` (manual)                        | Moves the Pi dev baseline in one step       |

The composite gates that bind them together:

- `npm run check:fast` — manifests, layers, workflow source shape, typecheck,
  Pi host version, tests, and source audit. The inner loop while editing; it
  is not release-complete.
- `npm run check` — `check:fast` plus formatting, published Markdown links,
  the generated public catalogs, repository hygiene, and release
  metadata. The canonical gate:
  deterministic, offline, and read-only, and exactly what CI runs. Everything
  CI adds after it needs the network (`npm audit`) or the runner environment
  (`pi --version`, the pack candidate).
- `npm run check:push` — `check` plus a dry-run pack. The tracked `pre-push`
  hook runs this.

## CI gates

### check-extension-layers.ts

The ownership ledger for `extensions/_shared`. Every shared file is classified
into one of the six named layers, and the script mechanically enforces the
rules a reviewer cannot hold in their head across pull requests: no shared
module may import feature code, a layer may only import layers at or below its
own rank, `Symbol.for("locus-pi.…")` registries must match their declared
owning module, declared mutable module state must stay where declared, and
feature-internal modules are reachable from other features only through their
declared facade. The per-file ledger and the full rule list live in the
script's header comment — read it before moving shared modules, and update the
ledger in the same change instead of loosening a rule.

### check-workflow-source-shape.ts

Runs the standard source-shape validator over every workflow example the
package ships (or over explicit paths passed as arguments, which must then
declare the standard profile). Guards that shipped workflows keep passing the
same static checks user-authored workflows go through.

### check-markdown-links.ts

Resolves every relative link and heading anchor in tracked repository Markdown.
`http(s)` links are deliberately out of scope because checking them needs the
network. The parser lives in `markdown-links.ts` and is shared with
`tests/integration/package-boundary.test.ts`, which applies the same rule to a
real `npm pack` result. `tests/integration/markdown-links.test.ts` proves the
gate rejects a broken link and a broken anchor.

### audit-sources.ts

Verifies source-ownership metadata for every active extension: an extension
adapted from third-party code must carry completed review metadata in its
`manifest.json`, `docs/third-party-notices.md` must retain the required Pi,
Oh My Pi, and MIT attributions, and no public manifest may link internal
source-audit notes. Exists because parts of the extension tree started as
adapted third-party code, and attribution and review state must not silently
rot.

### check-pi-host-version.mjs

Verifies the Pi development baseline is coherent: the four
`@earendil-works/pi-*` packages are installed at one identical version, that
version matches the exact devDependency pins and sits at or above the
peerDependencies floor, and the `pi` binary (local install, or `PI_BIN`)
reports the same version as the installed SDK. Extensions are loaded by the
user's Pi installation at runtime, so a CLI/SDK skew would invalidate local
test evidence.

### check-pull-request-policy.ts

Enforces branch and release policy on pull requests, reading the `GITHUB_*`
environment CI provides. Pull requests into `dev` must come from a task
branch and must update `CHANGELOG.md` when they touch release-relevant paths;
pull requests into `main` must be the release pull request from `dev`, bump
the package version, and carry a dated changelog heading for it. No other
target branch is accepted.

### check-release-metadata.ts

Verifies the package version is valid semver, `CHANGELOG.md` has a dated
`## [x.y.z] - YYYY-MM-DD` heading for it, and — on tag builds — the git tag
matches `v<version>`. The changelog-heading check is shared with the
pull-request policy script.

### extension-manifest-sources.ts

The one resolver of the active extension manifest set — exactly the manifests
`package.json#pi.extensions` declares. `check-extension-manifests.ts` and
`build-public-catalogs.ts` both read it, so the validating gate and the
generator can never disagree about which files are in the set. It classifies
each entry instead of throwing, because the checker reports every finding
while the generator must stop at the first unreadable file.

## Build

### build-public-catalogs.ts

Two enumerable public sets — the extensions `package.json#pi.extensions`
activates and the workflow names `extensions/workflows/examples/` resolves —
were transcribed by hand into two documentation pages and two contract
tests, and each copy could drift on its own. This script resolves both from
the readers that own them (`extension-manifest-sources.ts`, and the packaged
workflow discovery the registry itself uses) and writes them once, into
`dist/public-catalogs.json` and into the fenced `<!-- locus:…:start -->`
regions of `docs/extensions.md` and `docs/workflows.md`.

`npm run build:catalogs` writes; `npm run check:generated` re-renders into
memory and fails on any committed byte that differs, naming the write command.
The output is formatted with the repository Prettier config, so a regenerated
table cannot be correct and still fail `format:check`. It never imports a
workflow module: names come from the same directory scan the registry uses,
and each purpose line from a bounded static parse of the source text.

The catalog artifact is committed: contract tests read it, so a fresh clone
must have it before anything is built.

## Repository hygiene

### check-repository.ts

Uses Git as the repository inventory. It scans tracked files and visible
untracked files, while respecting `.gitignore`. The check rejects forbidden
internal paths, symlinks, absolute workstation paths, private keys, and npm
authentication data.

## Maintenance

### sync-pi-host-version.mjs

The maintenance counterpart to `check-pi-host-version.mjs`: reads the version
of the resolved `pi` binary, refuses versions below the peer floor, installs
all four Pi packages at exactly that version with `--save-dev --save-exact`,
and re-runs the check. Use it to move the Pi development baseline in one
step, then run `npm run check` before committing `package.json` and
`package-lock.json`.
