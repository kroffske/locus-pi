# Repository scripts

Development-time tooling for this repository: the validation gates CI runs on
every push and pull request, plus build, publication, and maintenance
utilities. Nothing here ships with the npm package — `package.json#files` does
not include `scripts/` — so every script may assume a full development
checkout: devDependencies installed, git history present.

TypeScript scripts run through `tsx`; `.mjs` scripts run on plain `node`.
Each one is bound to an npm script in `package.json`, except the manual
publication tool noted below.

| Script                             | npm script                                     | Role                                        |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `audit-sources.ts`                 | `audit:sources` (part of `check:fast`)         | Source-ownership and attribution gate       |
| `build-public-catalogs.ts`         | `build:catalogs` / `check:generated`           | Writes and verifies the two public catalogs |
| `build-workflow-source-shape.ts`   | `build:workflow-source` (`prepack`)            | Builds the shipped workflow-shape validator |
| `check-extension-layers.ts`        | `check:layers` (part of `check:fast`)          | `extensions/_shared` layer and import rules |
| `check-extension-manifests.ts`     | `check:manifests` (part of `check:fast`)       | Manifest schema and declared-path contract  |
| `check-markdown-links.ts`          | `check:links` (part of `check`)                | Internal links in published Markdown        |
| `extension-manifest-sources.ts`    | — (library)                                    | The one reader of the active manifest set   |
| `check-pi-host-version.mjs`        | `check:pi-host` (part of `check:fast`)         | Pi CLI/SDK version coherence                |
| `check-public-repository.ts`       | `check:repository` (part of `check`)           | Public-tree inventory and hygiene           |
| `check-pull-request-policy.ts`     | `check:pull-request`                           | Branch and release policy for PRs           |
| `check-release-metadata.ts`        | `check:release` (part of `check`)              | Version, changelog, and tag consistency     |
| `check-workflow-source-shape.ts`   | `check:workflow-source` (part of `check:fast`) | Packaged workflow source shape              |
| `markdown-links.ts`                | — (library)                                    | The one Markdown link parser both gates use |
| `materialize-public-repository.ts` | — (manual)                                     | Generates the public copy and its inventory |
| `sync-pi-host-version.mjs`         | `sync:pi-host` (manual)                        | Moves the Pi dev baseline in one step       |

The composite gates that bind them together:

- `npm run check:fast` — manifests, layers, workflow source shape, typecheck,
  Pi host version, tests, and source audit. The inner loop while editing; it
  is not release-complete.
- `npm run check` — `check:fast` plus formatting, published Markdown links,
  the generated public catalogs, the repository inventory, and release
  metadata. The canonical gate:
  deterministic, offline, and read-only, and exactly what CI runs. Everything
  CI adds after it needs the network (`npm audit`) or the runner environment
  (`locus-pi doctor`, `pi --version`, the pack candidate).
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

Resolves every relative link and heading anchor in published Markdown against
the file set that actually publishes it — `package.json#files` for the npm
tarball, `public-repository-files.txt` for the public repository — because
documentation is read from inside one of those, where the rest of this
checkout does not exist. A link that resolves here and not there is dead for
everyone who installed or cloned. `http(s)` links are deliberately out of
scope: reaching them needs the network, so they cannot belong to an offline
deterministic gate. The parser lives in `markdown-links.ts` and is shared with
`tests/integration/package-boundary.test.ts`, which applies the same rule to a
real `npm pack` result; `tests/integration/markdown-links.test.ts` proves the
gate rejects a broken link and a broken anchor.

### audit-sources.ts

Verifies source-ownership metadata for every active extension: an extension
adapted from third-party code must carry completed review metadata in its
`manifest.json`, `THIRD_PARTY_NOTICES.md` must retain the required Pi,
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
were transcribed by hand into three documentation pages and two contract
tests, and each copy could drift on its own. This script resolves both from
the readers that own them (`extension-manifest-sources.ts`, and the packaged
workflow discovery the registry itself uses) and writes them once, into
`dist/public-catalogs.json` and into the fenced `<!-- locus:…:start -->`
regions of `README.md`, `docs/extensions.md`, and `docs/workflows.md`.

`npm run build:catalogs` writes; `npm run check:generated` re-renders into
memory and fails on any committed byte that differs, naming the write command.
The output is formatted with the repository Prettier config, so a regenerated
table cannot be correct and still fail `format:check`. It never imports a
workflow module: names come from the same directory scan the registry uses,
and each purpose line from a bounded static parse of the source text.

Unlike `dist/workflow-source-shape.mjs`, which `prepack` builds, the catalog
artifact is committed: contract tests read it, so a fresh clone must have it
before anything is built.

### build-workflow-source-shape.ts

Transpiles `extensions/workflows/workflow-source-shape.ts` into
`dist/workflow-source-shape.mjs` — the only generated artifact the package
ships. It lets workflow tooling validate `.workflow.mjs` sources without a
TypeScript loader. Runs automatically on `npm pack` and `npm publish` via
`prepack`, and before the public-inventory comparison via `check:repository`.

## Publication pair

### check-public-repository.ts

The read half: compares the working tree (tracked plus untracked, minus
ignored) against the `public-repository-files.txt` inventory, then rejects
forbidden internal paths, symlinks, absolute workstation paths, private key
material, and npm auth configuration. The npm script first rebuilds
`dist/workflow-source-shape.mjs`, because the inventory lists it while nothing
else in the gate produces it: the comparison would otherwise pass only in a
checkout where a prior test or pack run happened to leave it behind. It runs
inside `npm run check`, and the repository-governance integration test reuses
its exports.

### materialize-public-repository.ts

The write half, and the only script without an npm binding:

```
tsx scripts/materialize-public-repository.ts <empty-destination>
```

Copies the allowlisted files — `package.json#files` plus
`public-repository.json#repositoryFiles`, minus the declared excludes — into
an empty directory outside the repository, and generates
`public-repository-files.txt` there. This is how the public inventory is
(re)produced; `check-public-repository.ts` then verifies any checkout against
it. When the allowlist in `public-repository.json` changes, rerun this and
copy the regenerated inventory back.

## Maintenance

### sync-pi-host-version.mjs

The maintenance counterpart to `check-pi-host-version.mjs`: reads the version
of the resolved `pi` binary, refuses versions below the peer floor, installs
all four Pi packages at exactly that version with `--save-dev --save-exact`,
and re-runs the check. Use it to move the Pi development baseline in one
step, then run `npm run check` before committing `package.json` and
`package-lock.json`.
