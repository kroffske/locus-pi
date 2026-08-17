# Extension index

This is the public `0.3.0` extension ledger and source map. The machine-owned
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
  `operator`, `runtime`, `model`, `project`, and `agent-runtime`. Its 44 recursive
  regular files are counted separately as infrastructure, not as an
  independently loaded extension.
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

**File counts** are a live snapshot of all recursive regular files under each
`extensions/<id>/` directory, including manifests, Markdown, examples,
references, and other non-TypeScript assets. They exclude `extensions/_shared/`,
which is infrastructure rather than a public extension.

| Extension             | Files | Status | Ownership / risk          | Purpose and public surface                                                                             | Entrypoint                                | Manifest                                       | Active manual                                   | Direct feature dependencies | Shared layers                                           | External packages                                                                                  |
| --------------------- | ----: | ------ | ------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `agents`              |    17 | active | locus-specific / high     | Agent catalog, child sessions, `/agent`, `/ps`, and canonical `spawn_agent`                            | `extensions/agents/index.ts`              | `extensions/agents/manifest.json`              | `docs/extensions/active/agents.md`              | `workflows`                 | `agent-runtime`, `host`, `model`, `operator`, `runtime` | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox`                   |
| `ask-user-question`   |    12 | active | compat-wrapper / medium   | Canonical human-in-the-loop `ask` tool with option and rich single-question shapes                     | `extensions/ask-user-question/index.ts`   | `extensions/ask-user-question/manifest.json`   | `docs/extensions/active/ask-user-question.md`   | none                        | `host`, `operator`, `runtime`                           | `@earendil-works/pi-tui`, `@sinclair/typebox`                                                      |
| `ast-structural-edit` |     6 | active | compat-wrapper / high     | Structural `ast_grep` search, `ast_edit` preview, and stale-checked `resolve`                          | `extensions/ast-structural-edit/index.ts` | `extensions/ast-structural-edit/manifest.json` | `docs/extensions/active/ast-structural-edit.md` | none                        | `host`, `runtime`                                       | `@ast-grep/lang-python`, `@ast-grep/napi`, `@sinclair/typebox`                                     |
| `devext-doctor`       |     3 | active | locus-specific / low      | `/devext doctor` and read-only task-lifecycle diagnostics                                              | `extensions/devext-doctor/index.ts`       | `extensions/devext-doctor/manifest.json`       | `docs/extensions/active/devext-doctor.md`       | none                        | `host`, `operator`, `project`                           | none                                                                                               |
| `loop`                |    10 | active | compat-wrapper / medium   | Bounded automatic continuation through canonical `loop` and `/loop`                                    | `extensions/loop/index.ts`                | `extensions/loop/manifest.json`                | `docs/extensions/active/loop.md`                | `workflows`                 | `host`, `operator`, `project`                           | `@sinclair/typebox`                                                                                |
| `model`               |    10 | active | compat-wrapper / medium   | Persisted model-role routing and `/effort`; Pi retains operator-owned `/model` and `/models`           | `extensions/model/index.ts`               | `extensions/model/manifest.json`               | `docs/extensions/active/model.md`               | none                        | `host`, `model`, `operator`, `runtime`                  | `@earendil-works/pi-tui`                                                                           |
| `plan`                |    18 | active | locus-specific / high     | Behavioral plan mode, goal runtime, prompt shelves, planning/review/todo commands, and the `goal` tool | `extensions/plan/index.ts`                | `extensions/plan/manifest.json`                | `docs/extensions/active/plan.md`                | none                        | `host`, `operator`, `project`                           | `@earendil-works/pi-coding-agent`, `@sinclair/typebox`                                             |
| `security-gate`       |     3 | active | locus-specific / critical | `/security-audit` and an audit-only `tool_call` observer                                               | `extensions/security-gate/index.ts`       | `extensions/security-gate/manifest.json`       | `docs/extensions/active/security-gate.md`       | none                        | `host`, `operator`                                      | `@earendil-works/pi-tui`                                                                           |
| `status-line`         |     3 | active | locus-specific / low      | Responsive violet TUI footer for working location, context, compaction, model, and effort              | `extensions/status-line/index.ts`         | `extensions/status-line/manifest.json`         | `docs/extensions/active/status-line.md`         | none                        | `agent-runtime`, `host`, `operator`                     | `@earendil-works/pi-tui`                                                                           |
| `todo-context`        |    14 | active | compat-wrapper / high     | Session `todo_read`/`todo_write`, bounded opt-in settled continuation, and operator `/todo`            | `extensions/todo-context/index.ts`        | `extensions/todo-context/manifest.json`        | `docs/extensions/active/todo-context.md`        | none                        | `host`, `operator`, `project`, `runtime`                | `@sinclair/typebox`                                                                                |
| `workflows`           |    78 | active | locus-specific / critical | Workflow runtime, `/workflows`, `workflow`, opt-in `/fusion` + `fusion`, and four Package namespaces   | `extensions/workflows/index.ts`           | `extensions/workflows/manifest.json`           | `docs/extensions/active/workflows.md`           | none                        | `agent-runtime`, `host`, `model`, `operator`            | `@ast-grep/napi`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox` |

## Manifest-declared public surfaces

Here, **methods/surfaces** means only the tools, commands, hooks, and shortcuts
listed in each extension's `manifest.json#provides`; it does not include
implementation-level TypeScript exports. An em dash means that the manifest
declares no entries in that category (or omits the empty optional category).

| Extension             | Tools                             | Commands                                                                                                      | Hooks                                                                            | Shortcuts    |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| `agents`              | `spawn_agent`                     | `agent list`, `agent inspect`, `agent run`, `agent observe`, `agent summary`, `agent drill`, `agent ps`, `ps` | `session_start`, `before_agent_start`                                            | `shift+down` |
| `ask-user-question`   | `ask`                             | —                                                                                                             | —                                                                                | —            |
| `ast-structural-edit` | `ast_grep`, `ast_edit`, `resolve` | —                                                                                                             | —                                                                                | —            |
| `devext-doctor`       | —                                 | `devext doctor`, `devext task-lifecycle <task-id> <target-status>`                                            | `input`                                                                          | —            |
| `loop`                | `loop`                            | `loop`                                                                                                        | `agent_settled`                                                                  | —            |
| `model`               | —                                 | `model-roles`, `effort`                                                                                       | `session_start`                                                                  | —            |
| `plan`                | `goal`                            | `plan`, `mode`, `goal`, `goal-ai`, `review`, `todos`                                                          | `session_start`, `before_agent_start`                                            | —            |
| `security-gate`       | —                                 | `security-audit`                                                                                              | `tool_call`                                                                      | —            |
| `status-line`         | —                                 | —                                                                                                             | `session_start`, `session_before_compact`, `session_compact`, `session_shutdown` | —            |
| `todo-context`        | `todo_read`, `todo_write`         | `todo`                                                                                                        | `agent_settled`                                                                  | —            |
| `workflows`           | `workflow`, `fusion`              | `workflows`, `workflow-stop`, `fusion`                                                                        | `session_start`, `session_shutdown`, `input`, `turn_end`, `agent_settled`        | —            |

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

`extensions/workflows/examples/` is the registry: every `<name>/` directory
owns an optional `<name>/<name>.workflow.mjs` and any direct child entries. It
currently holds four namespaces: three runnable roots, one group-only namespace,
and nine runnable children:

| Workflow                      | Purpose                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `implement`                   | Applies explicitly selected plan or review actions, independently verifies them, and permits one correction. |
| `live-smoke`                  | Proves two full-tool child sessions on a live Pi host through a small file-listing action.                   |
| `task/plan`                   | Maps one task, then writes `plan.md`, dynamic `steps.md`, and a reviewable generated execution script.       |
| `task/implement`              | Gives one approved exact step to one implementation agent and records its changes, checks, and status.       |
| `post-code-review`            | External parent: scope, four parallel review lanes, necessity challenge, synthesis, and publication.         |
| `post-code-review/scope`      | Resolves the requested target and immutable Git semantics into `review-scope.md`.                            |
| `post-code-review/boundaries` | Reviews ownership, placement, dependency direction, coupling, facades, and seams.                            |
| `post-code-review/simplicity` | Reviews duplication, redundant machinery, dead paths, and delete-first alternatives.                         |
| `post-code-review/contracts`  | Reviews APIs, consumers, validation parity, errors, defaults, documentation, and tests.                      |
| `post-code-review/style`      | Reviews comments and evidence-backed project style, including request-local `style.md` criteria.             |
| `post-code-review/necessity`  | Challenges each proposed fix for proof, ownership, duplicated responsibility, and net simplicity.            |
| `post-code-review/synthesis`  | Independently verifies all lane claims and writes the final `post-code-review.md`.                           |

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
