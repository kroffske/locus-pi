# locus-pi

`locus-pi` is a Pi extension package for Locus agentic-development workflows.
It provides ten default extensions, a bundled agent catalog, six curated
Package workflows, and one skill that teaches an agent how to use them, through
a deliberately narrow npm artifact.

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
| `todo-context`        | Provides model-callable `todo_write`, opt-in bounded queue continuation, and the operator `/todo` view with atomic batch append plus run/pause controls.                                                                                               |
| `workflows`           | Provides `/workflows`, first-class `/workflow-*` commands, and the `workflow` tool for reviewed trusted JavaScript workflows, child-agent orchestration, and actionable operator handoffs.                                                             |

Each retained extension also has a manifest and a manual under
[`docs/extensions/active/`](docs/extensions/active/). Maintainer source-audit
evidence remains in the public GitHub repository rather than the npm artifact.

## Curated Package workflows

Only these names are registered as Package workflows:

| Workflow             | Intended use                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Runs two small read-only child-agent jobs to prove that the installed Pi host can create real child sessions. |
| `requirements-grill` | Collects bounded repository context, challenges a request, and returns a structured requirements handoff.     |
| `review`             | Reviews a free-form target through review units and falsifiable questions, publishing `review.md`.            |
| `review-fix`         | Scopes, revalidates, and applies the findings a human kept in `review.md`, then verifies and reports.         |
| `plan`               | Clarifies one task with the operator, then drafts and critiques until a shaped verdict accepts `plan.md`.     |
| `plan-implement`     | Consumes an accepted `plan.md` from its source run and gives each selected step one write-capable agent.      |

Use the operator catalog to inspect and run them:

```text
/workflow-list
/workflow-info live-smoke
/workflow-run live-smoke
/workflow-stop last
/ps
```

`/workflow-run` starts one interactive run in the background and returns the
editor immediately. The compact widget below the editor shows the current
workflow stage and one active child; `/ps` expands the same shared agent fleet
for leaf selection and readable drill-down. A second interactive run in the
same session/project is rejected until the first run settles. `/workflow-stop [runId|last]`
requests cancellation and remains honest about the run being
`stopping` until its terminal result is persisted. The programmatic `workflow`
tool remains awaited and headless. Compatibility `/workflows <subcommand>`
forms remain available.

When a workflow declares an actionable operator handoff, its oldest pending
question opens directly in the primary editor after Pi is idle. Escape snoozes
without cancelling; bare `/workflows` reopens it. `/workflow-continue` answers
the source run through verified artifacts and one atomic continuation claim.

Project and user workflow directories remain scan-based. A pi-native
`<name>.workflow.mjs` in `.pi/workflows/`, `.claude/workflows/`,
`.agents/workflows/`, or `~/.pi/workflows/` can change the next resolution result
without changing the Package registry. That exact filename is the only one these
directories accept, and a workflow written for another host's DSL is not portable
here. Files that merely exist under the repository's workflow examples are not
Package workflows and cannot be launched by bare name unless they are in the
curated registry.

## The shipped skill

Nothing has to be copied anywhere for the six workflows above to be runnable:
they resolve out of the installed package, so `/workflow-list` shows them the
first time Pi starts after `pi install`, whether the package came from npm or
from a local checkout.

What an agent could not previously find is the _concept_. A model asked to "run
the review workflow" had no document telling it what a workflow is here, which
names exist, or how to read a finished run, so it went looking for a repository
that is not on the machine. The package therefore ships one skill,
[`skills/locus-workflows/SKILL.md`](skills/locus-workflows/SKILL.md), declared
through `package.json#pi.skills`. Pi loads package skills automatically and
enabled, so its description is in the system prompt from the first session and
the full text loads on demand — including through `/skill:locus-workflows`. It
covers finding a workflow, running one, reading the result envelope, the name
resolution order, and the authoring template with the four rules that decide
whether a new file runs at all.

The file is a plain [Agent Skills](https://agentskills.io/specification)
directory, so other hosts can read it too. Claude Code and Codex discover skills
only under their own roots, so link the installed directory into the root that
host uses instead of copying it — a copy stops matching the package on the next
update. Pi writes user installs under `~/.pi/agent/npm/` and project installs
under `.pi/npm/`; `pi list` prints the source of every registration, and the
skill is at `skills/locus-workflows/` inside whichever one applies.

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
- Pi `0.82.x`; the package peer floor is `0.82.0`.
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

### 1. Remove any earlier installation first

Two registrations of the same package both load, so clear the old one before
adding the checkout. The two ways this package can already be present are
different things and are removed differently:

```bash
pi list                              # what Pi actually loads, per scope
pi remove npm:@kroffske/locus-pi     # user scope  (~/.pi/agent/settings.json)
pi remove npm:@kroffske/locus-pi -l  # project scope (.pi/settings.json)
```

```bash
which locus-pi                       # a globally installed CLI, if any
npm rm -g @kroffske/locus-pi
```

`pi remove` is the one that matters: it unregisters the extensions. A global npm
install only puts the `locus-pi` CLI on `PATH` and never registers anything with
Pi, so removing it changes no session behavior — remove it anyway if you want a
single source of truth for `locus-pi doctor`.

`pi list` is the authority. It prints user-scope and project-scope packages
separately, and the same checkout registered in both scopes appears twice; drop
it from one of them.

A source is matched by its resolved path, not by the string in the settings
file, so `pi remove -l .` from the checkout root removes an entry stored as
`".."`, and passing the absolute path works too.

Runtime state Pi wrote under `~/.pi/<project>/` is not an installation. Leave it
alone unless you mean to discard that history.

### 2. Install the checkout

```bash
npm ci --ignore-scripts
pi install -l .        # project scope: records the checkout in .pi/settings.json
npm run check
./bin/locus-pi doctor  # expects: 10 extensions, all ok
```

Use `pi install .` without `-l` to register the checkout for every project of
this user instead. Prefer `-l` while reviewing: a project-scoped entry cannot
follow you into an unrelated repository. Review the checkout before approving
project-local code — Pi loads its extension source, and this package does not
sandbox it.

A session started after that loads the extensions straight from the working
tree, so an edit is live on the next start with no reinstall step.

### 3. Go back to the published package

```bash
pi remove . -l                      # or: pi remove .   for the user scope
pi install npm:@kroffske/locus-pi
pi list
```

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
