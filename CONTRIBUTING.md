# Contributing

`locus-pi` is MIT-licensed and maintained through the branch and pull-request
process below. Public issues and pull requests are welcome when they follow the
security and contribution boundaries in this repository.

## Branch and pull-request flow

1. Update local `dev` from `origin/dev`.
2. Create a task or milestone branch from `dev`.
3. Commit and push only the task branch.
4. Open a pull request into `dev` and squash-merge it after CI and review.
5. Release through a pull request from `dev` into `main` and merge it with a
   merge commit.
6. Create the matching `vX.Y.Z` tag after the release pull request lands.

Direct commits and pushes to `main` or `dev` are not part of the supported
workflow. `main` remains the default GitHub branch because it represents the
stable release surface.

## Before changing code

1. Read `AGENTS.md`, `README.md`, and `docs/README.md`.
2. For extension work, inspect `package.json#pi.extensions`, the extension
   manifest, its active manual, the ownership matrix, and its source-audit note.
3. Do not widen the default extension list, curated Package workflow registry,
   runtime dependencies, or npm file allowlist without an explicit ownership
   decision and matching proof.
4. Treat project and user workflow files as trusted JavaScript, not sandboxed
   configuration.

## Development setup

Use Node.js `>=22.19.0` and a compatible Pi `0.80.x` host.

```bash
npm ci --ignore-scripts
npm run hooks:install
pi install -l .
```

The tracked hooks require `gitleaks` for staged secret scanning. On macOS:

```bash
brew install gitleaks
```

## Required validation

Run the checks that match the change. Code and package-boundary changes require:

```bash
npm run check
npm audit --omit=dev
./bin/locus-pi doctor
./node_modules/.bin/pi --version
npm pack --dry-run --json --ignore-scripts
```

`npm run check:push` runs the deterministic local push gate. CI repeats the
full repository and package checks, so bypassing a local hook does not bypass
review evidence.

Docs-only changes do not need runtime smoke when they do not change active
behavior claims. They still require source verification and `git diff --check`.

## Change expectations

- Keep each change bounded and explain the user-visible outcome.
- Add or update focused tests for runtime behavior.
- Keep manual docs, manifests, ownership records, and source-audit notes aligned.
- Update `CHANGELOG.md` in every pull request with user-visible package,
  runtime, manual, security, or support changes.
- Do not bump the package version on routine task branches. The `dev` to `main`
  release pull request owns the version bump and dated changelog heading.
- Do not commit secrets, credentials, private runtime state, generated reports,
  or absolute workstation paths.
- Do not add publish tokens, release automation, repository visibility changes,
  or legal metadata without owner authorization.

Report suspected vulnerabilities through the private process in `SECURITY.md`,
never through a public issue or pull request.
