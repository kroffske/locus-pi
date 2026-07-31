# Active extension docs

These pages describe the ten entrypoints currently loaded by `package.json#pi.extensions`.

Each default extension has exactly one dedicated bundled agent profile. The
public [extension-agent map](../../extension-agent-map.md) is the catalog
contract for those assignments; generic bundled agents remain available too.

Source truth remains code-first:

- `package.json#pi.extensions` defines the default loadable surface.
- `extensions/<extension>/manifest.json` defines commands, tools, hooks, permissions, risk, state, review status, and docs/source-audit paths.
- These pages explain current behavior for humans. They do not promote beta code by themselves.

Active pages:

- [agents](agents.md)
- [ask-user-question](ask-user-question.md)
- [ast-structural-edit](ast-structural-edit.md)
- [devext-doctor](devext-doctor.md)
- [loop](loop.md)
- [model](model.md)
- [plan](plan.md)
- [security-gate](security-gate.md)
- [todo-context](todo-context.md)
- [workflows](workflows.md)
