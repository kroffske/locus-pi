# Public extension catalog

This catalog is the operator- and planning-facing roster of the public extensions
shipped by this package. It covers exactly `package.json#pi.extensions` (ten
extensions). The extension index remains the detailed source map; this page is
the concise catalog of names, public roles, paths, and dependency boundaries.

A **direct feature dependency** is a source import, re-export, type import, or
literal dynamic import from one `extensions/<feature>/` directory into another.
Imports from `extensions/_shared/<layer>/` are a separate shared-layer category:
shared infrastructure does not create an extension-to-extension edge. External
npm or Pi peer-package imports are also a separate external-package category,
not feature dependencies.

## Public roster

| Extension             | Purpose / public role                                                                                        | Entrypoint                                | Manifest                                       | Active manual                                   | Direct feature-extension dependencies | Shared-layer dependencies                               | External-package dependencies                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------- | ------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `agents`              | Agent catalog, child sessions, `/agent`, `/ps`, `spawn_agent`, legacy `task`, and workload diagnostics.      | `extensions/agents/index.ts`              | `extensions/agents/manifest.json`              | `docs/extensions/active/agents.md`              | `workflows`                           | `agent-runtime`, `host`, `model`, `operator`, `runtime` | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox`                   |
| `ask-user-question`   | Human-in-the-loop `ask` tool and legacy `askUserQuestion` alias.                                             | `extensions/ask-user-question/index.ts`   | `extensions/ask-user-question/manifest.json`   | `docs/extensions/active/ask-user-question.md`   | none                                  | `host`, `operator`, `runtime`                           | `@earendil-works/pi-tui`, `@sinclair/typebox`                                                      |
| `ast-structural-edit` | Structural `ast_grep` search, `ast_edit` preview and stale-checked apply, `resolve`, and legacy `ast_apply`. | `extensions/ast-structural-edit/index.ts` | `extensions/ast-structural-edit/manifest.json` | `docs/extensions/active/ast-structural-edit.md` | none                                  | `host`, `runtime`                                       | `@ast-grep/lang-python`, `@ast-grep/napi`, `@sinclair/typebox`                                     |
| `devext-doctor`       | `/devext doctor`, `/devext reload`, task-lifecycle diagnostics, and `devext_reload`.                         | `extensions/devext-doctor/index.ts`       | `extensions/devext-doctor/manifest.json`       | `docs/extensions/active/devext-doctor.md`       | none                                  | `host`, `operator`, `project`                           | `@sinclair/typebox`                                                                                |
| `loop`                | One bounded manual continuation through `/loop` and `loopControl`.                                           | `extensions/loop/index.ts`                | `extensions/loop/manifest.json`                | `docs/extensions/active/loop.md`                | `workflows/run-read.ts`               | `host`, `operator`, `project`                           | `@sinclair/typebox`                                                                                |
| `model`               | Persisted model-role routing and `/effort`; Pi retains operator-owned `/model` and `/models`.                | `extensions/model/index.ts`               | `extensions/model/manifest.json`               | `docs/extensions/active/model.md`               | none                                  | `host`, `model`, `operator`, `runtime`                  | `@earendil-works/pi-tui`                                                                           |
| `plan`                | Behavioral plan mode, goal runtime, prompt shelves, planning/review/todo commands, and the `goal` tool.      | `extensions/plan/index.ts`                | `extensions/plan/manifest.json`                | `docs/extensions/active/plan.md`                | none                                  | `host`, `operator`, `project`                           | `@earendil-works/pi-coding-agent`, `@sinclair/typebox`                                             |
| `security-gate`       | `/security-audit` and an audit-only `tool_call` observer.                                                    | `extensions/security-gate/index.ts`       | `extensions/security-gate/manifest.json`       | `docs/extensions/active/security-gate.md`       | none                                  | `host`, `operator`                                      | `@earendil-works/pi-tui`                                                                           |
| `todo-context`        | Session todos, `todo_write`, bounded opt-in settled continuation, and operator `/todo`.                      | `extensions/todo-context/index.ts`        | `extensions/todo-context/manifest.json`        | `docs/extensions/active/todo-context.md`        | none                                  | `host`, `operator`, `project`, `runtime`                | `@sinclair/typebox`                                                                                |
| `workflows`           | Workflow runtime, `workflow`, opt-in Fusion, and shipped Package workflows.                                  | `extensions/workflows/index.ts`           | `extensions/workflows/manifest.json`           | `docs/extensions/active/workflows.md`           | none                                  | `agent-runtime`, `host`, `model`, `operator`            | `@ast-grep/napi`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox` |

## Feature dependency edges

The direct feature graph has exactly two edges:

- `agents → workflows`, through progress UI, the persisted-run reader, and the
  background-run registry.
- `loop → workflows/run-read.ts`, the read-only persisted-run facade used to
  build a bounded continuation.

The other eight public extensions—`ask-user-question`, `ast-structural-edit`,
`devext-doctor`, `model`, `plan`, `security-gate`, `todo-context`, and
`workflows`—have no direct feature-extension imports. Their shared-layer and
external-package imports remain listed separately in the roster above.

## Roster boundary

Repository-only extensions, including local or historical modules outside the
package's `pi.extensions` list, are not part of this public roster. The shipped
list and this catalog must stay synchronized; beta, backlog, fixture, and local
runtime material is intentionally excluded.
