# Extension ownership matrix

This matrix records ownership of the ten `0.2.1` default extensions. `Locus`
means locally owned behavior. `compat-wrapper` means a bounded Pi-facing surface
whose source audit records the upstream contract and license context.

| Extension             | Status | Ownership      | Public boundary                                                                                                                                  |
| --------------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`              | active | Locus          | Local catalog and SDK child-session host. Direct child nesting is blocked; workflows remain the orchestration boundary.                          |
| `ask-user-question`   | active | compat-wrapper | OMP-compatible human-decision tool with honest UI fallbacks and a legacy alias.                                                                  |
| `ast-structural-edit` | active | compat-wrapper | OMP-shaped search, preview, approval, stale-check, and resolve contract under one active owner.                                                  |
| `devext-doctor`       | active | Locus          | Diagnostic and reload surface. Its status output never proves that excluded modules work.                                                        |
| `loop`                | active | compat-wrapper | One bounded manual continuation at a time; no hidden auto-dispatch or endless loop.                                                              |
| `model`               | active | compat-wrapper | Local role-routing state and UI. Pi owns active model selection through `/model` and `/models`.                                                  |
| `plan`                | active | Locus          | Behavioral planning/goal runtime. It guides the model but does not silently restrict tools or shell access.                                      |
| `security-gate`       | active | Locus          | Audit-only observer. Pi approval remains the enforcement owner.                                                                                  |
| `todo-context`        | active | compat-wrapper | `todo_write` mutates session task state; `/todo` is the operator view.                                                                           |
| `workflows`           | active | Locus          | Reviewed JavaScript executes with full Node.js host access. Only four Package names are curated; project/user sources remain trusted local code. |

## Machine truth

The public contract is the intersection of:

1. `package.json#pi.extensions`;
2. `extensions/<extension>/manifest.json`;
3. this ownership matrix.

Changing the default list requires all three surfaces, the active manual,
source-audit status, focused tests, and runtime evidence to change together.
Repository presence alone never promotes another extension or workflow.
