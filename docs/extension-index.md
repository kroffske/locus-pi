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
| `workflows`           | active | critical | `/workflows`, `workflow`, and the six shipped Package workflows                      | `./extensions/workflows/index.ts`           |

## Package workflows

`extensions/workflows/examples/` is the registry: every `<name>.workflow.mjs`
there resolves by name. It currently holds:

| Workflow             | Purpose                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Proves two small read-only SDK child sessions on a live Pi host.                                      |
| `requirements-grill` | Produces a bounded requirements challenge and handoff.                                                |
| `review`             | Reviews a free-form target through review units and falsifiable questions, publishing `review.md`.    |
| `review-fix`         | Scopes, revalidates, and applies the findings a human kept in `review.md`, then verifies and reports. |
| `plan`               | Clarifies one task, then drafts and critiques a plan until a read-only critic accepts it.             |
| `plan-implement`     | Implements one accepted plan with a writer per step, then checks and reports independently.           |

Every workflow directory is scan-based, including this one. What separates a
Package workflow from a project file is not the mechanism but the promise: the
shipped directory is a public surface covered by `package.json#files`, the
package-boundary test, and the support boundary. A file found under
`.pi/workflows/`, `.claude/workflows/`, or `.agents/workflows/` is local trusted
code with no such promise.

## Excluded material

The clean release repository and npm package exclude beta/backlog modules,
workflow references under `extensions/workflows/references/`, reports, galleries, transcripts, benchmarks,
evaluations, archives, and local runtime/planning state. Historical decisions
remain in the private internal repository; their absence here is intentional.
