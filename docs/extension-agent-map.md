# Extension-agent map

This is the public catalog of dedicated bundled agents for the default
extensions. Every default extension must have exactly one unique dedicated
agent row, and each row must point to the extension's manifest and bundled
agent profile.

The manifest's `agent.name` identifies the bundled profile. Its
`agent.description` is the caller-facing catalog description and is limited to
96 characters.

## Default extension assignments

| Extension             | Manifest agent name             | Agent profile                                     | Extension manifest                             |
| --------------------- | ------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `agents`              | `extension-agents`              | `.agents/agents/extension-agents.md`              | `extensions/agents/manifest.json`              |
| `ask-user-question`   | `extension-ask-user-question`   | `.agents/agents/extension-ask-user-question.md`   | `extensions/ask-user-question/manifest.json`   |
| `ast-structural-edit` | `extension-ast-structural-edit` | `.agents/agents/extension-ast-structural-edit.md` | `extensions/ast-structural-edit/manifest.json` |
| `devext-doctor`       | `extension-devext-doctor`       | `.agents/agents/extension-devext-doctor.md`       | `extensions/devext-doctor/manifest.json`       |
| `loop`                | `extension-loop`                | `.agents/agents/extension-loop.md`                | `extensions/loop/manifest.json`                |
| `model`               | `extension-model`               | `.agents/agents/extension-model.md`               | `extensions/model/manifest.json`               |
| `plan`                | `extension-plan`                | `.agents/agents/extension-plan.md`                | `extensions/plan/manifest.json`                |
| `security-gate`       | `extension-security-gate`       | `.agents/agents/extension-security-gate.md`       | `extensions/security-gate/manifest.json`       |
| `todo-context`        | `extension-todo-context`        | `.agents/agents/extension-todo-context.md`        | `extensions/todo-context/manifest.json`        |
| `workflows`           | `extension-workflows`           | `.agents/agents/extension-workflows.md`           | `extensions/workflows/manifest.json`           |

## Catalog contract

- The default extension set is defined by `package.json#pi.extensions`.
- Each default extension appears exactly once in the table above.
- Each manifest assignment resolves to one dedicated bundled profile under
  `.agents/agents/`.
- Agent names are unique across the default extension assignments.
