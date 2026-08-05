# model

Continuous model-route selection and effort assignment for Pi sessions.

This extension registers `/model-roles` and `/effort`; it does not shadow Pi's
built-in `/model` or `/models`. `/model-roles` is one model-first custom
`SELECT` flow: model → “Set as …” action → capability-backed effort → inline
receipt. The full model list opens first; provider filtering is an optional
`Tab` action rather than a selection step. After choosing a model, the model
list stays visible and its role actions open below it. Successful assignment
returns to the model list without closing the selector, so several routes can
be changed without reopening it. Assigned route markers and model values use
the warning color and routing roles render one per line. `q` closes; `Esc`/left
walks back before closing at the model list.

`CURRENT` is the live model of the main Pi session. `DEFAULT` is the action that
switches that live model and persists the choice; it is not an agent fallback.
The host `/model` command may later change `CURRENT` without rewriting the saved
choice. Other roles only save `model:effort` to project-local
`.pi/model-roles/config.json`. A profile with no `model:` uses `AGENT`; when
`AGENT` is unset, its child inherits `CURRENT`. `TASK` is consulted only when an
agent profile or workflow explicitly names that role. Since T-129 resolved
routes are executed — the resolved route becomes the child session's model
rather than metadata beside it. `PLAN`, `SUMMARY`, and `SMOL` remain visible
only with explicit beta/resolver/fallback capability labels.

Provider rows are real filters. Effort options come from Pi model
`reasoning`/`thinkingLevelMap`; unknown capability exposes only `off` instead
of pretending every level works. `/effort` keeps the host-owned selector but
labels it `[SELECT]`; confirmed changes, clamps, and failures render once as
typed `[CHANGE]`, `[WARN]`, or `[ERROR]` blocks. Cancelling does not mutate the
session or leave a result block. A bounded `model.roles` contribution is
published through the shared `locus` status slot and never repeats current
model, session effort, cwd, branch, context, or cost.

Without custom UI, `/model-roles` renders a typed read-only routing summary
instead of a plain notification. In RPC/noninteractive mode, no-arg `/effort`
does not pretend a selector is interactive; it returns a typed recovery to use
`/effort <level>`.

Optional `ctx.settings.modelRoles` remains a test/compatibility mirror. Legacy
user defaults from `~/.pi/agent/model-roles/config.json` are read-only fallback
inputs. The extension never stores provider credentials; auth remains owned by
Pi/provider configuration.
