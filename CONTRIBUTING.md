# Contributing

`locus-pi` is a release candidate, not an open-source release. No license has
been selected, so external contributions are not accepted yet. Adding a
`LICENSE` file and explicitly opening the contribution channel are owner gates.

Current maintainers and invited reviewers may use this document to prepare the
candidate. After the repository is opened, the same checks apply to pull
requests unless the project publishes a replacement policy.

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
pi install -l .
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

Docs-only changes do not need runtime smoke when they do not change active
behavior claims. They still require source verification and `git diff --check`.

## Change expectations

- Keep each change bounded and explain the user-visible outcome.
- Add or update focused tests for runtime behavior.
- Keep manual docs, manifests, ownership records, and source-audit notes aligned.
- Do not commit secrets, credentials, private runtime state, generated reports,
  or absolute workstation paths.
- Do not add publish tokens, release automation, repository visibility changes,
  or legal metadata without owner authorization.

Use the repository's normal pull-request route only after contributions are
formally opened. Report suspected vulnerabilities through the private process
in `SECURITY.md`, never through a public issue or pull request.
