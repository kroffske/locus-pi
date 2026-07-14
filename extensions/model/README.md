# model

Continuous model-route selection and effort assignment for Pi sessions.

This extension registers `/model-roles` and `/effort`; it does not shadow Pi's
built-in `/model` or `/models`. `/model-roles` is one custom `SELECT` flow:
model → routing role → capability-backed effort → inline receipt. Successful
assignment returns to the model list without closing the selector, so several
routes can be changed without reopening it. Assigned route markers and model
values use the warning color and routing roles render one per line. `q` closes;
`Esc`/left walks back before closing at the model list.

`Current session model` and persisted `DEFAULT route` are separate values.
Only `DEFAULT` calls `pi.setModel` and verified `pi.setThinkingLevel`; host
`/model` may later make Current diverge without rewriting the route. Other
roles only save `model:effort` to project-local
`.pi/model-roles/config.json`. `AGENT` is an active agents/workflows route and
`TASK` its fallback. `PLAN`, `SUMMARY`, and `SMOL` remain visible only with
explicit beta/resolver/fallback capability labels.

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
