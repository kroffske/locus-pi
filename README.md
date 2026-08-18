# locus-pi

`locus-pi` (as a dynamic workflow) is a Pi extension package for Locus
agentic development — the same idea as dynamic workflows in Claude Code,
built for the Pi coding agent.

One install gives a Pi session multi-agent orchestration: child agents,
deterministic multi-stage workflow pipelines, and inspectable run evidence.
The structure of a workflow carries the work, so a run stays readable and
reviewable instead of depending on model strength.

Use it as a reference. Run the curated workflows as they ship, then copy
their structure when you author your own.

## Requirements

- Node.js `>=22.19.0`
- Pi `0.83.x` (peer floor `0.83.0`)
- A trusted project, and reviewed sources for every workflow you run

## Install

From npm (the supported operator path):

```bash
pi install npm:@kroffske/locus-pi
```

Or from a git clone, when you want Pi to load the repository source itself —
to develop the package, or to test unreleased work from `dev`:

```bash
git clone https://github.com/kroffske/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
pi install .
```

Register one source identity, not both. `pi list` shows what Pi actually
loads per scope; drop an old registration with
`pi remove npm:@kroffske/locus-pi` or `pi remove <checkout-path>`, and
uninstall the same way.

Verify the install inside a Pi session:

```text
/workflows list           # curated namespaces resolve from the package
/workflows run live-smoke # smallest real proof that child agents spawn
```

## What is inside

Eleven default extensions (`package.json#pi.extensions`): `agents` (child
agents, `/agent`, `/ps`), `ask-user-question`, `ast-structural-edit`,
`devext-doctor`, `loop`, `model`, `plan`, `security-gate` (audit-only),
`status-line`, `todo-context`, and `workflows` (the `/workflows` surface and
the `workflow` tool). Each extension has a manual under
[`docs/extensions/active/`](docs/extensions/active/README.md); the docs index
is [`docs/README.md`](docs/README.md).

## Workflows

Curated Package workflows are the directories under
[`extensions/workflows/examples/`](extensions/workflows/examples/README.md):
each directory owns one namespace. Run a root with `/workflows run <name>` and a
child with `/workflows run <name>/<child>`. Project and User workflows with
the same name win over the Package copy.

### post-code-review

One scoped, four-lane parallel code review that ends in an independently
verified `post-code-review.md`. Children: `scope`, `boundaries`,
`simplicity`, `contracts`, `style`, `necessity`, and `synthesis`. The final
report grades `READY`, `READY_WITH_RECOMMENDATIONS`, `CHANGES_REQUIRED`, or
`BLOCKED`, and every item declares its `Action` and `Impact`.

### implement

Applies the REQUIRED work from a plan or review, verifies it independently,
and allows one corrective pass.

### workflow-creator

Creates a new workflow: `design` writes and reviews the agent graph, `svg`
draws its diagram, and `build` creates and rechecks the declared sources.

### task

Group-only planning pair. `task/plan` maps one task into `context.md`,
`plan.md`, and `steps.md`; `task/implement` executes exactly one approved
step.

### live-smoke

Two small child-agent jobs that list the project directory — proof the
installed host can create real child sessions.

Useful commands:

```text
/workflows
/workflows run post-code-review --output-dir tmp/post-code-review/review-1 review the current diff
/workflows status
/workflows stop last
/ps
```

## Skills

The package registers three Agent Skills automatically
(`package.json#pi.skills`):

- [`locus-pi-run-workflow`](skills/locus-pi-run-workflow/SKILL.md) — run,
  resume, or monitor an existing workflow, from Pi or from another host.
- [`locus-pi-workflows`](skills/locus-pi-workflows/SKILL.md) — author a new
  workflow: a reviewed `.design.md` first, then the matching source.
- [`locus-task-workflow`](skills/locus-task-workflow/SKILL.md) — the thin
  execution protocol for the `task` planning pair.

The authoring contract is
[`extensions/workflows/AUTHORING.md`](extensions/workflows/AUTHORING.md); the
full runtime reference is
[`docs/extensions/active/workflows.md`](docs/extensions/active/workflows.md).

## Trust and safety

Workflow files are trusted JavaScript. They run in Pi's main Node.js process
with full host access — filesystem, subprocesses, network. Path checks,
identity hashes, and Pi's approval prompts are evidence and consent
boundaries, not a sandbox. `security-gate` is audit-only telemetry and never
blocks a call. Review every workflow before running it.

## Support

None. The package is provided as is, without warranty of any kind — use at
your own risk. There is no support, response-time, or maintenance promise.
Report suspected vulnerabilities through GitHub private vulnerability
reporting (see `SECURITY.md` in the repository), never in a public issue.

## License

MIT — see [LICENSE](LICENSE). Upstream attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
