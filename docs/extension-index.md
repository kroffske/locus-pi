# Extension index

This is the public `0.2.1` extension ledger and source map. The machine-owned
default list is `package.json#pi.extensions`; each row below must have a matching
active manifest and manual. Beta, backlog, deleted, and fixture modules are not
part of this clean repository or the first public release.

## Repository layout

- `package.json#pi.extensions` is the source of truth for default extension
  entrypoints.
- `extensions/<id>/` contains one extension's source and `manifest.json`; the
  manifest is the machine-readable source for its ownership, risk, public
  surfaces, permissions, manual, and tests.
- `extensions/_shared/<layer>/` contains the six shared ownership layers: `host`,
  `operator`, `runtime`, `model`, `project`, and `agent-runtime`. Shared modules
  are infrastructure, not independently loaded extensions.
- `docs/extensions/active/<id>.md` is the active public manual declared by each
  manifest.
- `extensions/workflows/examples/` is the scan-based registry of shipped Package
  workflows.

## Default extensions

A **direct feature dependency** below means a static source import, re-export,
type import, or literal dynamic import from one `extensions/<feature>/`
directory into another. A `_shared` layer import is listed separately and does
not create an edge between extensions. **External packages** are direct
non-Node.js package or peer-package imports from that feature's source; they are
not feature edges either.

| Extension             | Status | Ownership / risk          | Purpose and public surface                                                                                          | Entrypoint                                | Manifest                                       | Active manual                                   | Direct feature dependencies | Shared layers                                           | External packages                                                                                  |
| --------------------- | ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `agents`              | active | locus-specific / high     | Agent catalog, child sessions, `/agent`, `/ps`, `spawn_agent`, legacy `task`, and diagnostic `locus_workload_proof` | `extensions/agents/index.ts`              | `extensions/agents/manifest.json`              | `docs/extensions/active/agents.md`              | `workflows`                 | `agent-runtime`, `host`, `model`, `operator`, `runtime` | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox`                   |
| `ask-user-question`   | active | compat-wrapper / medium   | Human-in-the-loop `ask` tool and legacy `askUserQuestion` alias                                                     | `extensions/ask-user-question/index.ts`   | `extensions/ask-user-question/manifest.json`   | `docs/extensions/active/ask-user-question.md`   | none                        | `host`, `operator`, `runtime`                           | `@earendil-works/pi-tui`, `@sinclair/typebox`                                                      |
| `ast-structural-edit` | active | compat-wrapper / high     | Structural `ast_grep` search, `ast_edit` preview and stale-checked apply, `resolve`, and legacy `ast_apply`         | `extensions/ast-structural-edit/index.ts` | `extensions/ast-structural-edit/manifest.json` | `docs/extensions/active/ast-structural-edit.md` | none                        | `host`, `runtime`                                       | `@ast-grep/lang-python`, `@ast-grep/napi`, `@sinclair/typebox`                                     |
| `devext-doctor`       | active | locus-specific / low      | `/devext doctor`, `/devext reload`, read-only task-lifecycle diagnostics, and `devext_reload`                       | `extensions/devext-doctor/index.ts`       | `extensions/devext-doctor/manifest.json`       | `docs/extensions/active/devext-doctor.md`       | none                        | `host`, `operator`, `project`                           | `@sinclair/typebox`                                                                                |
| `loop`                | active | compat-wrapper / medium   | One bounded manual continuation through `/loop` and `loopControl`                                                   | `extensions/loop/index.ts`                | `extensions/loop/manifest.json`                | `docs/extensions/active/loop.md`                | `workflows`                 | `host`, `operator`, `project`                           | `@sinclair/typebox`                                                                                |
| `model`               | active | compat-wrapper / medium   | Persisted model-role routing and `/effort`; Pi retains operator-owned `/model` and `/models`                        | `extensions/model/index.ts`               | `extensions/model/manifest.json`               | `docs/extensions/active/model.md`               | none                        | `host`, `model`, `operator`, `runtime`                  | `@earendil-works/pi-tui`                                                                           |
| `plan`                | active | locus-specific / high     | Behavioral plan mode, goal runtime, prompt shelves, planning/review/todo commands, and the `goal` tool              | `extensions/plan/index.ts`                | `extensions/plan/manifest.json`                | `docs/extensions/active/plan.md`                | none                        | `host`, `operator`, `project`                           | `@earendil-works/pi-coding-agent`, `@sinclair/typebox`                                             |
| `security-gate`       | active | locus-specific / critical | `/security-audit` and an audit-only `tool_call` observer                                                            | `extensions/security-gate/index.ts`       | `extensions/security-gate/manifest.json`       | `docs/extensions/active/security-gate.md`       | none                        | `host`, `operator`                                      | `@earendil-works/pi-tui`                                                                           |
| `status-line`         | active | locus-specific / low      | Responsive violet TUI footer for working location, context, compaction, model, and effort                           | `extensions/status-line/index.ts`         | `extensions/status-line/manifest.json`         | `docs/extensions/active/status-line.md`         | none                        | `agent-runtime`, `host`, `operator`                     | `@earendil-works/pi-tui`                                                                           |
| `todo-context`        | active | compat-wrapper / high     | Session todos, `todo_write`, bounded opt-in settled continuation, and operator `/todo`                              | `extensions/todo-context/index.ts`        | `extensions/todo-context/manifest.json`        | `docs/extensions/active/todo-context.md`        | none                        | `host`, `operator`, `project`, `runtime`                | `@sinclair/typebox`                                                                                |
| `workflows`           | active | locus-specific / critical | Workflow runtime, `/workflows`, `workflow`, opt-in `/fusion` + `fusion`, and six Package workflows                  | `extensions/workflows/index.ts`           | `extensions/workflows/manifest.json`           | `docs/extensions/active/workflows.md`           | none                        | `agent-runtime`, `host`, `model`, `operator`            | `@ast-grep/napi`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox` |

## Direct feature dependency graph

- `agents → workflows`: progress UI, the persisted-run reader, and the background
  run registry.
- `loop → workflows/run-read.ts`: the read-only persisted-run facade used to
  build a bounded continuation.
- `ask-user-question`, `ast-structural-edit`, `devext-doctor`, `model`, `plan`,
  `security-gate`, `status-line`, `todo-context`, and `workflows`: no direct feature imports.

These are source-level feature edges only. Sharing infrastructure through
`extensions/_shared/` does not imply that the consuming extensions depend on
one another, and importing an npm dependency or Pi peer package does not create
an extension edge.

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
