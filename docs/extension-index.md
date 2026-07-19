# Extension index

This is the public `0.2.1` extension ledger. The machine-owned default list is
`package.json#pi.extensions`; each row below must have a matching active
manifest and manual. Beta, backlog, deleted, and fixture modules are not part of
this clean repository or the first public release.

| Extension             | Status | Risk     | Public surface                                                                       | Entrypoint                                  |
| --------------------- | ------ | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `agents`              | active | high     | `/agent`, `/ps`, `spawn_agent`, legacy `task`, and diagnostic `locus_workload_proof` | `./extensions/agents/index.ts`              |
| `ask-user-question`   | active | medium   | `ask` and legacy `askUserQuestion`                                                   | `./extensions/ask-user-question/index.ts`   |
| `ast-structural-edit` | active | high     | `ast_grep`, `ast_edit`, `resolve`, and legacy `ast_apply`                            | `./extensions/ast-structural-edit/index.ts` |
| `devext-doctor`       | active | low      | `/devext doctor`, `/devext reload`, task-lifecycle diagnostics, and `devext_reload`  | `./extensions/devext-doctor/index.ts`       |
| `loop`                | active | medium   | `/loop` and `loopControl`                                                            | `./extensions/loop/index.ts`                |
| `model`               | active | medium   | `/model-roles` and `/effort`; Pi retains operator-owned `/model` and `/models`       | `./extensions/model/index.ts`               |
| `plan`                | active | high     | planning/mode/goal/review/todo prompt surfaces and the `goal` tool                   | `./extensions/plan/index.ts`                |
| `security-gate`       | active | critical | `/security-audit` and an audit-only `tool_call` observer                             | `./extensions/security-gate/index.ts`       |
| `todo-context`        | active | high     | `todo_write`, bounded settled continuation, and operator `/todo`                     | `./extensions/todo-context/index.ts`        |
| `workflows`           | active | critical | `/workflows`, `workflow`, and the three curated Package workflows                    | `./extensions/workflows/index.ts`           |

## Curated Package workflows

Only these names are registered by `CURATED_PACKAGE_WORKFLOW_NAMES`:

| Workflow             | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `live-smoke`         | Proves two small read-only SDK child sessions on a live Pi host. |
| `llm-smoke`          | Exercises direct workflow `llm()` calls.                         |
| `requirements-grill` | Produces a bounded requirements challenge and handoff.           |

Project and user workflow directories remain scan-based. A file found there is
local trusted code, not a Package workflow promise.

## Excluded material

The clean release repository and npm package exclude beta/backlog modules,
uncurated workflow examples, reports, galleries, transcripts, benchmarks,
evaluations, archives, and local runtime/planning state. Historical decisions
remain in the private internal repository; their absence here is intentional.
