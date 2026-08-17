# locus-pi

`locus-pi` is a Pi extension package for Locus agentic-development workflows.
Installing it gives a Pi session eleven extensions, a bundled agent catalog,
four curated Package workflow namespaces with twelve runnable names, and three
skills that teach an agent how to run, author, and coordinate them — through a
deliberately narrow npm artifact.

The package is built on deterministic decomposition, bounded capabilities, and
inspectable run evidence: the structure of a workflow carries the work, so a run
stays readable and reviewable instead of depending on model strength alone.

## Requirements

- Node.js `>=22.19.0`.
- Pi `0.83.x`; the package peer floor is `0.83.0`.
- A trusted project, and reviewed sources for every workflow you run.

## Install

Install the published package into Pi:

```bash
pi install npm:@kroffske/locus-pi
```

Confirm the registration and the shipped inventory:

```bash
pi list                        # what Pi actually loads, per scope
npx @kroffske/locus-pi doctor  # package root and the eleven entrypoints
```

Then start Pi in a trusted project and run `/workflows list`: the four curated
workflow namespaces and their twelve runnable names resolve out of the installed package, so nothing has to be copied
anywhere. Inside a session, `/devext doctor` gives the same kind of compact
inventory view.

Inventory output only reports what is registered. The smallest real check that
child agents work on this host is `/workflows run live-smoke`, which starts two
small child-agent jobs that list the current project directory.

Remove the package with the same source identity:

```bash
pi remove npm:@kroffske/locus-pi
```

npm is the supported operator path. Use
[a Git clone](#install-from-a-git-clone) only when you want Pi to load the
repository source itself.

## What the package includes

The machine-owned default list is `package.json#pi.extensions`. The package
contains exactly these eleven entrypoints:

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
| `status-line`         | Replaces Pi's interactive footer with one violet row for model, working directory/worktree, branch, context, cumulative tokens, compaction state, and existing extension statuses.                                                                     |
| `todo-context`        | Provides model-callable `todo_write`, opt-in bounded queue continuation, and the operator `/todo` view with atomic batch append plus run/pause controls.                                                                                               |
| `workflows`           | Provides the canonical `/workflows` menu, direct `/workflows <subcommand>` forms, the emergency `/workflow-stop` alias, and the `workflow` tool for trusted JavaScript orchestration.                                                                  |

Each extension ships its `manifest.json` and a manual under
[`docs/extensions/active/`](docs/extensions/active/README.md). Every default
extension also has one dedicated bundled agent profile, listed in the
[extension-agent map](docs/extension-agent-map.md); the generic bundled agents
remain available as well. The public [extension source and dependency
map](docs/extension-index.md) links every entrypoint, manifest, and manual and
separates direct feature imports from shared-layer and external-package
dependencies. Maintainer source-audit evidence stays in the public GitHub
repository rather than in the npm artifact.

## Curated Package workflows

The installed package registers four Package workflow namespaces. `implement`,
`live-smoke`, and `post-code-review` are runnable roots; `task` is group-only.
Together they expose twelve runnable names: the three roots, seven
`post-code-review/*` children, and `task/plan` plus `task/implement`.

| Workflow                      | Intended use                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `implement`                   | Applies authorized REQUIRED work from a plan or review, independently verifies it, and allows one corrective pass.               |
| `live-smoke`                  | Runs two child-agent jobs that list the current project directory to prove the installed Pi host can create real child sessions. |
| `task/plan`                   | Maps one task, writes `context.md`, `plan.md`, dynamic `steps.md`, and a reviewable generated execution script.                  |
| `task/implement`              | Gives one approved exact step to one implementation agent, which changes, verifies, and records only that step.                  |
| `post-code-review`            | Runs one scoped, four-lane parallel code review and publishes an independently verified `post-code-review.md`.                   |
| `post-code-review/scope`      | Resolves a function, file, commit, range, diff, or local PR into an exact review boundary.                                       |
| `post-code-review/boundaries` | Audits ownership, placement, dependency direction, coupling, facades, and seams.                                                 |
| `post-code-review/simplicity` | Audits duplication, empty wrappers, redundant guards, dead paths, and delete-first alternatives.                                 |
| `post-code-review/contracts`  | Audits APIs, consumers, validation parity, defaults, errors, documentation, tests, and intent.                                   |
| `post-code-review/style`      | Audits comments and evidence-backed project style, with optional request-local criteria from `style.md`.                         |
| `post-code-review/necessity`  | Challenges every proposed fix to prove a real failure, a guarantee owner, and the simplest net improvement.                      |
| `post-code-review/synthesis`  | Re-verifies the scope and four lane reports, removes unsupported claims, and authors the final report.                           |

The Package registry is the shipped `extensions/workflows/examples/` directory
itself: each `<name>/` owns one namespace with an optional same-named root plus
any direct child entries.
The npm allowlist ships every registered source explicitly, plus the
post-code-review README and SVG diagram.

The focused catalog separates Project, User, Package, and History into tabs,
shows the active catalog directory, and wraps descriptions at word boundaries.
Inspecting a folder-owned namespace offers safe copy actions to Project or User.
Copy preserves its root/children/resources, keeps group-only namespaces
group-only, and refuses to merge or overwrite an existing destination.

Inspect and run them from the canonical command menu:

```text
/workflows
/workflows list
/workflows info live-smoke
/workflows run live-smoke
/workflows run post-code-review --output-dir tmp/post-code-review/review-20260813-a review the current diff
/workflows run implement --output-dir tmp/post-code-review/review-20260813-a apply REQUIRED fixes from post-code-review.md
/workflows status
/workflows result last
/workflows stop last
/ps
```

Before launching `post-code-review`, an operator may write additional comment
and style criteria to `tmp/post-code-review/<review-id>/style.md`. The runtime
preserves that regular file byte-for-byte; when it is absent, the runtime creates
it empty before review work starts.

The final review uses `READY`, `READY_WITH_RECOMMENDATIONS`, `CHANGES_REQUIRED`,
or `BLOCKED`. Every item separately declares `Action: REQUIRED`, `RECOMMENDED`,
or `NO_ACTION` and `Impact: high`, `medium`, or `low`. Small fix snippets are
illustrative guidance for actionable items, never literal patches. `implement`
defaults to REQUIRED work, includes RECOMMENDED work only when explicitly asked,
and intentionally returns `NO_WORK` when nothing selected needs a change.

Bare `/workflows` opens the interactive command menu when TUI selection is
available; other hosts receive the typed help fallback. Its exact verbs are
`dashboard`, `list`, `info`, `status`, `result`, `run`, `continue`, and `stop`,
each shown with a short description, and direct typed forms such as
`/workflows run live-smoke` always work. Only `/workflow-stop` remains as an
emergency flat compatibility alias. In the catalog, each row leads with the
workflow name and a compact `[P]`, `[U]`, or `[PKG]` badge for its Project,
User, or Package source; history rows insert the run id after the name.

### Run from another agent

The package ships `locus-pi-run-workflow`, a capability-based run skill. In a
Pi session it calls the native `workflow` tool. In a host without that tool it
starts the installed Pi command surface directly; there is no
package-specific workflow executor:

```bash
pi --mode json -p --no-session --approve \
  '/workflows run live-smoke -- inspect this project'
```

Pass the slash command as one process argument. `--approve` grants Pi's broad
trust for project-local settings, packages, extensions, prompts, and resources;
workflow JavaScript runs with host authority and is not sandboxed. A non-Pi
caller reads only terminal custom-message events with
`customType: "locus-workflow-run"`: `workflow_start` exposes the absolute
`runDir`, `journalPath`, and `resultPath`, `workflow_rejected` closes a
pre-start refusal, and `workflow_end` carries terminal workflow status plus
`resultPersisted`. Pi may exit successfully after a typed workflow rejection or
failure, so the receipt, not the process exit code, decides the outcome. See the
[workflow manual](docs/extensions/active/workflows.md#run-from-an-agent-without-a-wrapper)
for the exact contract.

### Watching a run

`/workflows run` starts one interactive run in the background and returns the
editor immediately. The compact widget below the editor shows the current
workflow stage and one active child; `/ps` expands the same shared agent fleet
for leaf selection and readable drill-down. A second interactive run in the same
session and project is rejected until the first run settles.
`/workflows stop [runId|last]` requests cancellation and remains honest about the
run being `stopping` until its terminal result is persisted. The programmatic
`workflow` tool remains awaited and headless.

`/ps` drill-down renders the retained agent transcript with Pi's native
assistant and tool components in a terminal-height viewport that follows live
output without clearing terminal scrollback. Use `PgUp`/`PgDn` or `Home`/`End`
to inspect older output and `Ctrl+O` to toggle tool detail. While the child is
actively processing, the view mounts Pi's native editor and Enter sends it a
steering message; after settlement the view becomes read-only. `Esc` closes the
view without aborting the child. Transcript retention applies its documented
content, byte, and node bounds.

When a workflow declares an actionable operator handoff, a run launched by the
current Pi session (or one of its continuations) opens its oldest pending
question directly in the primary editor after Pi is idle. Escape submits an
explicit declined answer; it does not snooze or cancel. Otherwise open the
`/workflows` menu and choose `continue` to select an eligible handoff
oldest-first, or type `/workflows continue <runId>` to name one directly.

### Where a name resolves from

Every directory is scanned on each call. A canonical `<name>/` folder owns an
optional same-named root and its direct children; without that root it is a
group-only, non-runnable catalog namespace. The nearest Project namespace wins
as a whole, then User, then Package. Root and child refs are `<name>` and
`<name>/<child>`. Existing flat Project/User `<name>.workflow.mjs` files remain
compatible standalone roots. A workflow written for another host's DSL is not
portable here.

## Skills and workflow authoring

The package declares its skills through `package.json#pi.skills`, and Pi loads
package skills automatically and enabled: their descriptions are in the system
prompt from the first session, and the full text loads on demand.

[`skills/locus-pi-run-workflow/SKILL.md`](skills/locus-pi-run-workflow/SKILL.md)
owns requests to run, start, resume, or monitor the current run of an existing
workflow. It uses the native `workflow` tool when available and otherwise
invokes the registered slash command through `pi --mode json -p`, then follows
typed receipts and the canonical journal/result paths. Native-only `items` and
`continuation` requests fail as unsupported when the structured tool is absent;
the external route never drops them.

[`skills/locus-pi-workflows/SKILL.md`](skills/locus-pi-workflows/SKILL.md) owns
workflow authoring, also reachable through `/skill:locus-pi-workflows`. A raw
creation request writes and reviews a readable `.design.md` agent graph before
creating the matching source in the same turn. An explicit design-only request
pauses before source; `Build design: <exact path>` and `Build approved design:
<exact path>` remain build-only compatibility forms. Its compact Markdown
pattern cards load only after the author selects a topology.

[`skills/locus-task-workflow/SKILL.md`](skills/locus-task-workflow/SKILL.md) is
the thin execution protocol for the shipped planning pair. The main Pi agent
uses one shared `tmp/<select-name>` workspace, appends single-line step
references to session todos, and starts one top-level `task/implement` run with
the exact matching block from `steps.md`. A failed step stops the queue; a later
session reconstructs it by reading `steps.md` and `history/*.md`.

The full authoring contract — the Design/Build boundary, what a design must
expose, and the standard primitive profile — is
[`extensions/workflows/AUTHORING.md`](extensions/workflows/AUTHORING.md), and
the complete runtime, trust, replay, and artifact reference is
[`docs/extensions/active/workflows.md`](docs/extensions/active/workflows.md).

Check a newly authored standard workflow from its project directory with the
installed package command; no project-local script or `tsx` is required:

```bash
npx @kroffske/locus-pi check-workflow-source .pi/workflows/<name>/<name>.workflow.mjs
```

All three skills are plain [Agent Skills](https://agentskills.io/specification)
directories, so other hosts can read them too. Claude Code and Codex discover
skills only under their own roots, so link the installed directory into the root
that host uses instead of copying it — a copy stops matching the package on the
next update. Pi writes user installs under `~/.pi/agent/npm/` and project
installs under `.pi/npm/`; `pi list` prints the source of every registration,
and the skills are under `skills/` inside whichever one applies.

## Trust and safety boundary

Workflow files are trusted JavaScript. They run in Pi's main Node.js process
with full module access and may use the host filesystem, subprocesses, network,
or other capabilities. Path checks, identity hashes, and Pi's `exec` approval
are evidence and consent boundaries; they are not a sandbox. Review every
project or user workflow before running it.

`security-gate` is audit-only telemetry: it classifies dangerous tool calls and
records them for `/security-audit` review. It never blocks a call and never
replaces Pi's own approval prompts.

The npm package excludes beta modules, uncurated workflow fixtures, archives,
reports, galleries, transcripts, benchmarks, evaluations, and local runtime or
planning state. Their presence in a source checkout does not make them supported
package behavior.

## Install from a Git clone

Most operators do not need this. Use a source checkout only when you want Pi to
load the repository directly instead of the published npm package — to develop
the package itself, or to test accepted work before it is released. A normal
clone checks out the stable `main` branch:

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

Review the checkout before registering it: Pi loads extension source directly
from the cloned directory, under the same trust boundary described above.

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
./bin/locus-pi doctor  # expects: 11 extensions, all ok
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

Maintainers validate a checkout with the release-quality package checks:

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

Security reports go through GitHub private vulnerability reporting, so they do
not need to enter public issues or workflow transcripts.

The repository policy files and `.github/**` are intentionally not included in
the npm artifact. The shipped README carries the essential install, trust,
support-boundary, security-route, license, and attribution notices.

## License

`locus-pi` is available under the [MIT License](LICENSE). Retained upstream
copyright and license notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
