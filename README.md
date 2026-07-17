# locus-pi

`locus-pi` is a Pi extension package for Locus agentic-development workflows.
It provides ten default extensions, a bundled agent catalog, and four curated
Package workflows through a deliberately narrow npm artifact.

> `locus-pi` is MIT-licensed. Published releases use GitHub private
> vulnerability reporting so security reports do not need to enter public
> issues or workflow transcripts.

## What the package includes

The machine-owned default list is `package.json#pi.extensions`. The package
contains exactly these ten entrypoints:

| Extension             | Purpose and public surface                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`              | Loads the agent catalog and provides `/agent`, `/ps`, `spawn_agent`, and the legacy `task` alias. Child runs use Pi's `createAgentSession` host and fail closed when that host is unavailable. A completed run requires a real non-empty child answer. |
| `ask-user-question`   | Provides the primary `ask` human-decision tool. `askUserQuestion` remains a legacy compatibility alias.                                                                                                                                                |
| `ast-structural-edit` | Provides `ast_grep`, `ast_edit`, `resolve`, and the legacy `ast_apply` alias. `ast_edit` creates a preview; `resolve` writes only after Pi approval and a stale-file check.                                                                            |
| `devext-doctor`       | Provides `/devext doctor`, reload guidance, and read-only task-lifecycle diagnostics. Doctor output is an inventory/status view, not proof that disabled modules work.                                                                                 |
| `loop`                | Provides `/loop` and `loopControl` for bounded continuation state around an active goal.                                                                                                                                                               |
| `model`               | Provides `/model-roles` and `/effort` for role routing. Pi's operator-owned `/model` and `/models` selection surfaces are not model-callable tools from this package.                                                                                  |
| `plan`                | Provides plan, mode, goal, review, and prompt-shelf operator surfaces plus the `goal` tool.                                                                                                                                                            |
| `security-gate`       | Provides `/security-audit` and audit telemetry around tool calls. It is audit-only; it does not replace Pi approvals or enforce a blocking security policy.                                                                                            |
| `todo-context`        | Provides the model-callable `todo_write` task-list update tool. The `/todo` command is a separate human/operator view.                                                                                                                                 |
| `workflows`           | Provides `/workflows` and the `workflow` tool for reviewed trusted JavaScript workflows, agent orchestration, and direct model-call nodes.                                                                                                             |

Each retained extension also has a manifest and a manual under
[`docs/extensions/active/`](docs/extensions/active/). Maintainer source-audit
evidence remains in the public GitHub repository rather than the npm artifact.

## Curated Package workflows

Only these names are registered as Package workflows:

| Workflow             | Intended use                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `live-smoke`         | Runs two small read-only child-agent jobs to prove that the installed Pi host can create real child sessions.      |
| `llm-smoke`          | Exercises direct `llm()` calls without child sessions.                                                             |
| `requirements-grill` | Collects bounded repository context, challenges a request, and returns a structured requirements handoff.          |
| `review`             | Runs full agents that resolve a free-form target, inspect changes and whole-file context, and adjudicate findings. |

Use the operator catalog to inspect and run them:

```text
/workflows list
/workflows info live-smoke
/workflows run live-smoke
```

Project and user workflow directories remain scan-based. A valid file in
`.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/`, or
`~/.pi/workflows/` can change the next resolution result without changing the
Package registry. Files that merely exist under the repository's workflow
examples are not Package workflows and cannot be launched by bare name unless
they are in the curated registry.

## Trust and safety boundary

Workflow files are trusted JavaScript. They run in Pi's main Node.js process
with full module access and may use the host filesystem, subprocesses, network,
or other capabilities. Path checks, identity hashes, and Pi's `exec` approval
are evidence and consent boundaries; they are not a sandbox. Review every
project or user workflow before running it.

The npm package excludes beta modules, uncurated workflow fixtures, archives,
reports, galleries, transcripts, benchmarks, evaluations, and local runtime or
planning state. Their presence in a source checkout does not make them supported
package behavior.

## Requirements

- Node.js `>=22.19.0`.
- Pi `0.80.x`; the package peer floor is `0.80.3`.
- Ripgrep (`rg`) on `PATH`; the curated `requirements-grill` workflow uses it
  for its bounded read-only repository search.
- A trusted project and reviewed local workflow sources.

## Install

Install it with Pi:

```bash
pi install npm:@kroffske/locus-pi
```

Confirm the package registration and CLI inventory:

```bash
pi list
npx @kroffske/locus-pi doctor
```

Inside an interactive Pi session, `/devext doctor` provides a compact inventory
view. It does not replace the test suite or a live workflow smoke.

Remove the npm package with the same source identity:

```bash
pi remove npm:@kroffske/locus-pi
```

## Work from a source checkout

This path is for current maintainers and reviewers. It is not an npm
installation procedure.

```bash
npm ci --ignore-scripts
pi install -l .
npm run check
./bin/locus-pi doctor
```

`pi install -l .` records the local checkout in the project's
`.pi/settings.json`. Review the checkout before approving project-local code.

The release-quality package checks are:

```bash
npm run check
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

## Documentation and support

- [`docs/README.md`](docs/README.md) maps the package source of truth and public manuals.
- Repository-only `CONTRIBUTING.md` defines the current contribution gate and validation expectations.
- Repository-only `SUPPORT.md` separates usage questions, reproducible defects, and unsupported surfaces.
- Repository-only `SECURITY.md` defines the vulnerability-reporting gate.
- Repository-only `CODE_OF_CONDUCT.md` defines expected project conduct.
- Repository-only `CHANGELOG.md` records the release history.

The repository policy files and `.github/**` are intentionally not included in
the npm artifact. The shipped README carries the essential install, trust,
support-boundary, security-route, license, and attribution notices.

## License

`locus-pi` is available under the [MIT License](LICENSE). Retained upstream
copyright and license notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
