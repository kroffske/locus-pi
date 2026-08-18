# Workflow guide

The `workflows` extension discovers trusted JavaScript workflow modules, runs them through Pi child sessions, and persists evidence under `.pi/locus-pi/runs/<runId>/`.

## Package catalog

`extensions/workflows/examples/` is the shipped registry. The current package exposes seventeen runnable names:

| Workflow                      | Purpose                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `implement`                   | Apply explicitly authorized plan or review work, verify it, and permit one corrective pass.         |
| `live-smoke`                  | Prove that the installed host can start two real child sessions.                                    |
| `post-code-review`            | Run the complete scoped, parallel, independently synthesized review.                                |
| `post-code-review/scope`      | Resolve the exact review target and Git semantics.                                                  |
| `post-code-review/boundaries` | Review ownership, placement, dependencies, coupling, and seams.                                     |
| `post-code-review/simplicity` | Review duplication, redundant machinery, dead paths, and delete-first options.                      |
| `post-code-review/contracts`  | Review APIs, consumers, validation, errors, defaults, docs, and tests.                              |
| `post-code-review/style`      | Review comments and evidence-backed project style.                                                  |
| `post-code-review/necessity`  | Challenge proposed fixes for proof, ownership, and net simplicity.                                  |
| `post-code-review/synthesis`  | Verify lane claims and publish the final report.                                                    |
| `task/plan`                   | Map one task and write `context.md`, `plan.md`, and one `step-<n>.md` file per implementation step. |
| `task/script`                 | Render `execute.workflow.mjs` from the approved plan and step files.                                |
| `task/implement`              | Execute and verify one approved task step named by its step selector.                               |
| `workflow-creator`            | Design, diagram, build, and verify a workflow package without executing the generated workflow.     |
| `workflow-creator/design`     | Produce and independently review the workflow design.                                               |
| `workflow-creator/svg`        | Produce and independently review a self-contained SVG graph.                                        |
| `workflow-creator/build`      | Build and recheck only the design-declared source package.                                          |

`task` is a group-only namespace and is not runnable by itself.

## Operator commands

```text
/workflows
/workflows dashboard
/workflows list [query]
/workflows info [name]
/workflows status [runId]
/workflows result [runId|last]
/workflows run <name|path> [--output-dir <path>] [--resume <runId>] [--] [input]
/workflows continue <runId>
/workflows stop [runId|last]
```

Bare `/workflows` opens the command menu when interactive UI is available and otherwise prints typed help.

Use `--` when semantic input begins with an option-looking token. Run evidence defaults to `tmp/<workflow-name>`; `/workflows run <name|path> --output-dir <path>` selects an explicit safe project-relative workspace instead. `post-code-review` requires a fresh explicit project-relative `--output-dir`; resume must reuse the original workspace.

The model-callable `workflow` tool accepts a package name or trusted script path and supports structured fields such as `items`, `outputDir`, `resumeFromRunId`, and an approved continuation. Fields that have no slash-command representation must fail closed rather than be silently dropped.

## Run evidence

Each accepted run receives a stable directory:

```text
.pi/locus-pi/runs/<runId>/
  outputs/    human-readable host projection
  runtime/    machine evidence and continuation authority
    journal.ndjson         append-only lifecycle evidence
    result.json            terminal result and run metadata
    replay.ndjson          replay records when the source is eligible
    script-<sha256>.workflow.mjs
    artifacts/             answers, transcripts, result envelopes, inputs, and publications
```

Workflow-owned working files live separately under `<pwd>/tmp/<workflow-name>/` by default or in an explicit safe project-relative output directory. The workflow workspace and run-evidence directory must never resolve to the same directory.

Use `/workflows result` for complete prose output and `/workflows status` for stages, evidence, replay markers, and actionable handoffs.

## Resume and replay

`--resume <runId>` reuses eligible recorded agent answers only when source identity and request-prefix checks match. Replayed answers are marked as recorded evidence, not fresh work. Replay does not repeat child side effects or re-read files; use it only when those semantics are acceptable.

A run awaiting operator input must be continued explicitly. Automation must not synthesize an operator answer.

## Fusion

Fusion is disabled by default. `/fusion configure` or `/fusion set` defines a project-local homogeneous roster and judge; `/fusion enable` exposes the model-callable tool, and `/fusion disable` removes it again. Fusion forwards only the explicit question/context supplied to the call, not ambient session history.

## Trust and approvals

Workflow modules are trusted JavaScript executed in the Pi Node.js host. They may read or write files, start subprocesses, use the network, call models, or import modules according to host capabilities. Review every project or user workflow before execution.

Pi approvals remain the enforcement owner. Source hashes, confined output paths, journals, and audit events improve evidence and consent but do not provide OS-level isolation.

## Authoring

- [Readable workflow authoring contract](../extensions/workflows/AUTHORING.md)
- [Advanced runtime and DSL reference](../extensions/workflows/REFERENCE.md)
- [Packaged examples](../extensions/workflows/examples/README.md)
- [Workflow-author skill](../skills/locus-pi-workflows/SKILL.md)

Validate a standard-profile workflow source with:

```bash
npx @kroffske/locus-pi check-workflow-source path/to/example.workflow.mjs
```
