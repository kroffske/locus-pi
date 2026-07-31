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
[`docs/extensions/active/`](docs/extensions/active/README.md). Every default
extension has one dedicated bundled agent profile, published in the
[extension-agent map](docs/extension-agent-map.md); the generic bundled agents
remain available as well. The public [extension source and dependency
map](docs/extension-index.md) links every entrypoint, manifest, and manual and
separates direct feature imports from shared-layer and external-package
dependencies. Maintainer source-audit evidence remains in the public GitHub
repository rather than the npm artifact.

## Curated Package workflows

Only these names are registered as Package workflows:

| Workflow             | Intended use                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Runs two small read-only child-agent jobs to prove that the installed Pi host can create real child sessions.   |
| `requirements-grill` | Reads the repository, challenges a rough request against it, and returns a structured requirements handoff.     |
| `review`             | Reviews a free-form target through review units and falsifiable questions, publishing `review.md`.              |
| `review-fix`         | Scopes, revalidates, and applies the findings a human kept in `review.md`, then verifies and reports.           |
| `plan`               | Scouts the repository, then drafts and critiques until a shaped verdict accepts `plan.md`.                      |
| `plan-implement`     | Turns an accepted `plan.md` into a task ledger, then writes, reviews, and if needed repairs each task in order. |

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
[`skills/locus-pi-workflows/SKILL.md`](skills/locus-pi-workflows/SKILL.md), declared
through `package.json#pi.skills`. Pi loads package skills automatically and
enabled, so its description is in the system prompt from the first session and
the full text loads on demand — including through `/skill:locus-pi-workflows`. It
covers finding a workflow, running one, reading the result envelope, the name
resolution order, and the authoring template with the four rules that decide
whether a new file runs at all.

The file is a plain [Agent Skills](https://agentskills.io/specification)
directory, so other hosts can read it too. Claude Code and Codex discover skills
only under their own roots, so link the installed directory into the root that
host uses instead of copying it — a copy stops matching the package on the next
update. Pi writes user installs under `~/.pi/agent/npm/` and project installs
under `.pi/npm/`; `pi list` prints the source of every registration, and the
skill is at `skills/locus-pi-workflows/` inside whichever one applies.

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

## Install from a Git clone

Use a source checkout when you want Pi to load the repository directly instead
of the published npm package. A normal clone checks out the stable `main`
branch:

```bash
git clone https://github.com/kroffske/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
```

To test accepted integration work before it is released from `main`, clone the
`dev` branch instead:

```bash
git clone --branch dev https://github.com/kroffske/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
```

Review the checkout before registering it. Pi loads extension source directly
from the cloned directory; this package does not sandbox that code.

### 1. Remove any earlier registration

Two registrations of the same package both load, so clear the old one before
adding the checkout. The package can already be registered from npm or from
another checkout, and each source identity is removed separately:

```bash
pi list                              # what Pi actually loads, per scope
pi remove npm:@kroffske/locus-pi     # user scope  (~/.pi/agent/settings.json)
pi remove npm:@kroffske/locus-pi -l  # project scope (.pi/settings.json)
pi remove /absolute/path/to/old/locus-pi
pi remove /absolute/path/to/old/locus-pi -l
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
file. Run `pi remove .` from the registered checkout root, or pass that
checkout's absolute path. Do this before deleting or moving the directory.

Runtime state Pi wrote under `~/.pi/<project>/` is not an installation. Leave it
alone unless you mean to discard that history.

### 2. Register the checkout for this user

```bash
pi install .
pi list
npm run check
./bin/locus-pi doctor  # expects: 10 extensions, all ok
```

`pi install .` registers the checkout at user scope, so Pi loads these
extensions when started from this repository or any other directory. `pi list`
must show the checkout once.

Do not also run `pi install . -l` for the same checkout. That adds a second,
project-scoped registration; Pi then loads both copies when started in this
repository and reports duplicate tool names. If Pi works elsewhere but fails
inside `locus-pi`, remove the project-scoped copy:

```bash
cd /absolute/path/to/locus-pi
pi remove . -l
pi list
```

Maintainers who intentionally want a checkout active only for this project may
use `pi install . -l` instead of `pi install .`, but never both.

### 3. Update the checkout

The registration points to the checkout path, so updating in place does not
require another `pi install`:

```bash
cd /absolute/path/to/locus-pi
git pull --ff-only
npm ci --ignore-scripts
./bin/locus-pi doctor
```

Start a fresh Pi session after updating so it reloads the extension source.

### 4. Uninstall the checkout

Unregister the source before deleting its directory:

```bash
cd /absolute/path/to/locus-pi
pi remove .
pi list
```

If the checkout was registered with `pi install . -l`, remove it with
`pi remove . -l` from that project instead. Removing the registration does not
delete the checkout or Pi's runtime history.

To go back to the published package:

```bash
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
