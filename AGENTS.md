# locus-pi development contract

## Delivery

- `main` is the stable release branch. `dev` is the integration branch.
- Start focused work from current `dev` and open a pull request back into `dev`.
- Squash-merge normal work. Release through a merge-commit pull request from `dev` to `main`, then create the matching `vX.Y.Z` tag.
- Never commit `.locus/`, `.tasks/`, `.pi/`, runtime output, credentials, or workstation-specific state.

## Validation

```bash
npm ci --ignore-scripts
npm run hooks:install
npm run check:push
```

Use Node.js `>=22.19.0`. Pi supports `>=0.83.0`; development and CI use the exact version pinned in the four `@earendil-works/pi-*` development dependencies. Use `npm run sync:pi-host` to update that baseline.

`npm run check` is the canonical deterministic gate. CI runs the same command, then adds the network dependency audit, Pi peer check, and npm pack candidate.

## Ownership

- Shared code lives in the named layers under `extensions/_shared/`. Read `scripts/check-extension-layers.ts` before moving it.
- A shared module may not import a feature directory. Cross-feature imports use an explicitly owned facade.
- Versioned `globalThis` registries have one owning module.

## Public package

The public contract is `package.json#pi.extensions`, extension manifests, co-located manuals, packaged workflows, focused tests, and `package.json#files`.

- Do not widen extensions, workflows, dependencies, permissions, or the npm package without matching proof and documentation.
- Cross-cutting guides live in `docs/`. Extension behavior lives in `extensions/<name>/README.md`.
- Git is the public repository inventory. `package.json#files` is the separate npm-package boundary.
- User-visible changes update `CHANGELOG.md#Unreleased`.
