# locus-pi

`locus-pi` is a Pi extension package for agentic software-development workflows. It installs eleven default extensions, a bundled agent catalog, three agent skills, and a curated workflow registry with sixteen runnable workflow names.

The package favors explicit orchestration, bounded execution, and inspectable run evidence. It does not turn workflow code into a sandbox: extensions and workflow scripts execute inside the trusted Pi/Node.js host.

## Requirements

- Node.js `>=22.19.0`
- Pi `0.83.x` (peer floor `0.83.0`)
- A trusted project and reviewed workflow sources

## Install

```bash
pi install npm:@kroffske/locus-pi
pi list
npx @kroffske/locus-pi doctor
```

Start a fresh Pi session in a trusted project, then inspect the package:

```text
/devext doctor
/workflows list
```

Run the smallest live child-session check:

```text
/workflows run live-smoke
```

Remove the package with the same source identity:

```bash
pi remove npm:@kroffske/locus-pi
```

Source-checkout installation, duplicate-registration recovery, and uninstall details are in [Getting started](docs/getting-started.md).

## Included extensions

The authoritative default list is `package.json#pi.extensions`; each extension also declares its public surface in `extensions/<name>/manifest.json`.

| Extension             | Main public surface                                | Manual                                             |
| --------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `agents`              | `spawn_agent`, `/agent`, `/ps`                     | [README](extensions/agents/README.md)              |
| `ask-user-question`   | `ask`                                              | [README](extensions/ask-user-question/README.md)   |
| `ast-structural-edit` | `ast_grep`, `ast_edit`, `resolve`                  | [README](extensions/ast-structural-edit/README.md) |
| `devext-doctor`       | `/devext doctor`, task-lifecycle diagnostics       | [README](extensions/devext-doctor/README.md)       |
| `loop`                | `loop`, `/loop`                                    | [README](extensions/loop/README.md)                |
| `model`               | `/model-roles`, `/effort`                          | [README](extensions/model/README.md)               |
| `plan`                | `/plan`, `/mode`, `/goal`, prompt shelves, `goal`  | [README](extensions/plan/README.md)                |
| `security-gate`       | `/security-audit`, audit-only `tool_call` observer | [README](extensions/security-gate/README.md)       |
| `status-line`         | Interactive Pi footer                              | [README](extensions/status-line/README.md)         |
| `todo-context`        | `todo_read`, `todo_write`, `/todo`                 | [README](extensions/todo-context/README.md)        |
| `workflows`           | `/workflows`, `workflow`, optional Fusion          | [README](extensions/workflows/README.md)           |

The consolidated catalog, including commands, hooks, risk level, and direct feature dependencies, is in [Extension reference](docs/extensions.md).

## Curated Package workflows

The package scans `extensions/workflows/examples/`, which ships five curated Package workflow namespaces with sixteen runnable names; each `<name>/` owns one namespace with an optional same-named root plus any direct child entries (`task` itself is group-only).

| Workflow                      | Purpose                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `implement`                   | Apply explicitly authorized plan or review work, verify it, and permit one corrective pass.     |
| `live-smoke`                  | Prove that the installed host can start two real child sessions.                                |
| `post-code-review`            | Run the complete scoped, parallel, independently synthesized review.                            |
| `post-code-review/scope`      | Resolve the exact review target and Git semantics.                                              |
| `post-code-review/boundaries` | Review ownership, placement, dependencies, coupling, and seams.                                 |
| `post-code-review/simplicity` | Review duplication, redundant machinery, dead paths, and delete-first options.                  |
| `post-code-review/contracts`  | Review APIs, consumers, validation, errors, defaults, docs, and tests.                          |
| `post-code-review/style`      | Review comments and evidence-backed project style.                                              |
| `post-code-review/necessity`  | Challenge proposed fixes for proof, ownership, and net simplicity.                              |
| `post-code-review/synthesis`  | Verify lane claims and publish the final report.                                                |
| `task/plan`                   | Map one task and write `context.md`, `plan.md`, `steps.md`, and a generated execution workflow. |
| `task/implement`              | Execute and verify one approved task step.                                                      |
| `workflow-creator`            | Design, diagram, build, and verify a workflow package without executing the generated workflow. |
| `workflow-creator/design`     | Produce and independently review the workflow design.                                           |
| `workflow-creator/svg`        | Produce and independently review a self-contained SVG graph.                                    |
| `workflow-creator/build`      | Build and recheck only the design-declared source package.                                      |

Use `/workflows list` for the live first-wins catalog across the five curated workflow namespaces and their sixteen runnable names, and [Workflow guide](docs/workflows.md) for commands, storage, trust, and authoring entry points.

## Trust boundary

- Extension and workflow code runs with the capabilities of the Pi host process.
- Project and user workflow files are trusted JavaScript, not declarative configuration and not sandboxed.
- Pi approvals remain the enforcement owner for approved tool actions.
- `security-gate` records audit observations; it does not block calls or replace Pi approvals.
- Persisted workflow evidence helps inspection and replay, but it is not an isolation boundary.

Review local workflow sources before running them, especially when they can write files, invoke subprocesses, use the network, or call models.

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Extension reference](docs/extensions.md)
- [Workflow guide](docs/workflows.md)
- [Architecture and repository boundaries](docs/architecture.md)
- [Contributing](https://github.com/kroffske/locus-pi/blob/main/CONTRIBUTING.md)
- [Support](https://github.com/kroffske/locus-pi/blob/main/SUPPORT.md)
- [Security policy](https://github.com/kroffske/locus-pi/blob/main/SECURITY.md)

## Development

```bash
npm ci --ignore-scripts
npm run check
npm audit --omit=dev
npm pack --dry-run --json --ignore-scripts
```

See [CONTRIBUTING.md](https://github.com/kroffske/locus-pi/blob/main/CONTRIBUTING.md) before changing package surfaces, manifests, workflows, or the npm allowlist.

## License

`locus-pi` is available under the [MIT License](LICENSE). Retained upstream notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
