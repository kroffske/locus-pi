# Extension reference

The authoritative default list is `package.json#pi.extensions`. The table below is a readable index; each manifest remains the machine-owned declaration.

| Extension             | Tools                             | Commands                                                                                                      | Hooks                                                                            | Risk     | Manual                                                                                    |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `agents`              | `spawn_agent`                     | `agent list`, `agent inspect`, `agent run`, `agent observe`, `agent summary`, `agent drill`, `agent ps`, `ps` | `session_start`, `session_shutdown`, `before_agent_start`, `input`               | high     | [`extensions/agents/README.md`](../extensions/agents/README.md)                           |
| `ask-user-question`   | `ask`                             | —                                                                                                             | —                                                                                | medium   | [`extensions/ask-user-question/README.md`](../extensions/ask-user-question/README.md)     |
| `ast-structural-edit` | `ast_grep`, `ast_edit`, `resolve` | —                                                                                                             | —                                                                                | high     | [`extensions/ast-structural-edit/README.md`](../extensions/ast-structural-edit/README.md) |
| `devext-doctor`       | —                                 | `devext doctor`, `devext task-lifecycle <task-id> <target-status>`                                            | `input`                                                                          | low      | [`extensions/devext-doctor/README.md`](../extensions/devext-doctor/README.md)             |
| `loop`                | `loop`                            | `loop`                                                                                                        | `agent_settled`, `input`                                                         | medium   | [`extensions/loop/README.md`](../extensions/loop/README.md)                               |
| `model`               | —                                 | `model-roles`, `effort`                                                                                       | `session_start`, `input`                                                         | medium   | [`extensions/model/README.md`](../extensions/model/README.md)                             |
| `plan`                | `goal`                            | `plan`, `mode`, `goal`, `goal-ai`, `review`, `todos`                                                          | `session_start`, `before_agent_start`, `input`                                   | high     | [`extensions/plan/README.md`](../extensions/plan/README.md)                               |
| `security-gate`       | —                                 | `security-audit`                                                                                              | `tool_call`, `input`                                                             | critical | [`extensions/security-gate/README.md`](../extensions/security-gate/README.md)             |
| `status-line`         | —                                 | —                                                                                                             | `session_start`, `session_before_compact`, `session_compact`, `session_shutdown` | low      | [`extensions/status-line/README.md`](../extensions/status-line/README.md)                 |
| `todo-context`        | `todo_read`, `todo_write`         | `todo`                                                                                                        | `agent_settled`, `input`                                                         | high     | [`extensions/todo-context/README.md`](../extensions/todo-context/README.md)               |
| `workflows`           | `workflow`, `fusion`              | `workflows`, `workflow-stop`, `fusion`                                                                        | `session_start`, `session_shutdown`, `input`, `turn_end`, `agent_settled`        | critical | [`extensions/workflows/README.md`](../extensions/workflows/README.md)                     |

## Direct feature dependencies

Shared imports through `extensions/_shared/` are infrastructure dependencies, not extension-to-extension dependencies. The current direct feature graph is:

- `agents → workflows`
- `loop → workflows/run-read.ts`

The other default extensions do not directly import another feature directory.

## Reading a manifest

Important fields in `extensions/<name>/manifest.json`:

- `provides` — public tools, commands, hooks, and shortcuts;
- `permissions` — declared filesystem, subprocess, network, browser, model, and UI capabilities;
- `risk` — review severity, not a sandbox guarantee;
- `runtimeRequirements` and `stateUsed` — detailed execution and persistence contracts;
- `docsPath` — co-located extension manual;
- `tests` and `review` — evidence ownership and review metadata.

A manifest describes the intended contract. Source and tests remain necessary evidence that the implementation matches it.
