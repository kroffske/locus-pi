# model

## Purpose

`model` — active compatibility wrapper over the `model-settings` runtime service.
It registers `/model-roles` and `/effort`, but does not take over the host-owned
`/model` or `/models`. `/model-roles` configures persisted routing roles; the
built-in Pi selector still owns ordinary model switching for the current session.

## User Surface

`/model-roles` opens a single typed `SELECT` flow:

1. **Model** — pick a model through a real provider filter.
2. **Role** — pick a route with an explicit runtime capability.
3. **Effort** — pick only a thinking level supported by the model.
4. **Receipt** — see the saved route or a clear error.

After a successful assignment the selector returns to the model list and keeps
the inline receipt. Another model or role can be picked right away without
invoking the command again. `q` closes the selector; `Esc`/left returns to the
previous step, and on the model list it closes the selector.

Every frame has an explicit `[SELECT] Model roles` container. Inside it, the
following are shown separately:

- `Current session model` — the current model of the Pi session;
- `DEFAULT route` — the persisted fallback from the model-role config;
- `Routing roles` — saved non-default routes, one per line;
- `Provider filters` — list control, not yet another status line;
- `Available roles` — a bounded legend of all six routes, shortened on narrow;
- the selected model/role/effort and an inline `[OK]`, `[WARN]` or `[ERROR]` receipt;
- the keyboard controls of the current step.

## Current session and DEFAULT route

`Current session model` and `DEFAULT route` are not one value. Only a `DEFAULT`
assignment calls `pi.setModel`, then applies and verifies
`pi.setThinkingLevel`, and only then saves the route. If the host did not accept
the model or clamped the effort, the route is not saved silently: the selector
stays usable and shows the error.

The built-in host `/model` can later change Current without changing the
persisted `DEFAULT route`. On the next open the selector shows that divergence
on two separate lines.

A non-default role assignment does not change the session model or the session
effort. It saves an explicit `provider/model:effort` route.

## Runtime capability of roles

| Role      | Capability                          | Actual consumer                                                       |
| --------- | ----------------------------------- | --------------------------------------------------------------------- |
| `DEFAULT` | `active · session + route fallback` | Current session action and the last fallback of every resolver chain. |
| `AGENT`   | `active · agents/workflows primary` | Default-loaded `agents` and the workflow agent bridge.                |
| `TASK`    | `fallback · agents/workflows`       | Fallback after `AGENT` for the same active consumers.                 |
| `PLAN`    | `dormant · beta prompt planning`    | Only the disabled beta `prompt-planning`; no default-loaded consumer. |
| `SUMMARY` | `dormant · resolver only`           | Resolver contract and tests; no default-loaded consumer.              |
| `SMOL`    | `fallback-only · summary resolver`  | Fallback in `SUMMARY → SMOL → DEFAULT`; no active summary caller yet. |

The selector deliberately does not present a dormant/resolver-only role as a
fully active capability. The full source map is recorded in the task-local
consumer audit T-203.

## Provider filters and responsive layout

`ALL` and provider names are list filters. On a wide/regular terminal they are
shown as a single labelled `Provider filters:` line. At 48 columns the selector
shows the current filter and the position in the carousel, for example
`Provider filter 2/4: [OPENAI]`. The model window is bounded to 8/6/4 lines for
wide/regular/narrow width, and the selected row and stage focus are kept
deterministically after a mutation.

The active filter is highlighted with the Pi theme token `success`; any assigned
model and its markers (`Current`, `DEFAULT`, `AGENT`, `TASK`, `PLAN`, `SUMMARY`,
`SMOL`) use the warm `warning`. Unassigned model/role identity and the current
cursor use `accent` plus `>`/bold. Color is not the only signal: square labels,
role names, filter brackets and the cursor marker remain in the plain
projection.

## Capability-backed effort

The Pi `0.80.3` model registry reports capability through `reasoning` and
`thinkingLevelMap`. The selector uses the same semantics as Pi:

- a non-reasoning model supports only `off`;
- `null` in `thinkingLevelMap` excludes the level;
- `xhigh` is shown only with an explicit mapping;
- unknown capability fails closed and shows only `off`;
- legacy `thinking: string[]` remains an explicit compatibility shim.

The official Pi API clamps an unsupported thinking level. Therefore
`/model-roles` and `/effort` check capability up front, and after a host
mutation they verify the actual result. Unsupported/clamped effort is not
presented as a successful apply.

`/effort <level>` changes only the effort of the current session model.
`/effort` without an argument uses the host select with capability-backed
options and an explicit `[SELECT] Thinking effort` title. Because the host
`select` does not accept a separate initial index, the extension puts the
current supported level first: Enter without navigation keeps the current
value. Such an idempotent choice does not call `pi.setThinkingLevel` and returns
an honest `[VIEW]`; `[CHANGE]` remains reserved for a confirmed mutation,
`[WARN]` for a host clamp, `[ERROR]` for an invalid/unsupported level or an
unavailable host API.
Cancelling does not change the session effort and does not create a result
block. The command does not write route state and does not duplicate the typed
result with a separate plain notification.
In noninteractive/RPC mode a no-arg call does not simulate the selector:
`[WARN]` shows the current/supported effort and the recovery `/effort <level>`.
If `/model-roles` did not get custom UI or configured models, the typed
read-only fallback distinguishes `Current session model`, `DEFAULT route` and
other routes, states explicitly that no mutation was performed, and does not
create a separate host notification.

## Persistence and precedence

Project role store: `.pi/model-roles/config.json`. User fallback:
`~/.pi/agent/model-roles/config.json` or
`$PI_MODEL_ROLES_HOME/model-roles/config.json`.

Effective precedence: `session → settings → project → user`. The Pi runtime does
not provide `ctx.settings`; that branch remains a test/compatibility mirror.
A project `null` means inheritance of the user value. The user config is
read-only.

A successful apply also tries to append the session custom entry
`customType="model-roles"`. With `LOCUS_PI_SESSION_STORE=jsonl` the extension
writes `model_role_runtime_event` with the requested/current model/effort and
honest `modelApplied`, `thinkingApplied`, `rolePersisted` flags.

## Persistent status

The extension removes the legacy private key `model-roles` and publishes a single
`model.roles` contribution through the shared status key `locus`. The
contribution shows only a bounded routing summary/count. It does not repeat the
host-owned current model, effort, cwd, branch, context or cost; the full route
stays discoverable in the selector.

## How it works in code

- `extensions/model/index.ts` — command registration, Pi mutation, persistence,
  runtime evidence and status publication.
- `extensions/model/model-role-selector.ts` — role capability catalog,
  responsive model rows, provider filters and continuous keyboard state.
- `extensions/_shared/model-settings.ts` — parsing, precedence, persistence and
  purpose resolvers.
- `extensions/_shared/operator-ui.ts` — typed selector and command-result
  rendering (`SELECT`, `CHANGE`, `WARN`, `ERROR`).
- `extensions/_shared/operator-status.ts` — bounded shared status registry.

Pi contracts:

- [Extensions: setModel/thinking/custom UI](https://pi.dev/docs/latest/extensions)
- [TUI components and invalidation](https://pi.dev/docs/latest/tui)
- [Custom model capability fields](https://pi.dev/docs/latest/models)

## Package boundary and limitations

- Default-loaded entrypoint: `./extensions/model/index.ts`.
- Commands: `model-roles`, `effort`; tools: none.
- Hook: `session_start` synchronizes the routing contribution.
- The provider registry, credentials and the built-in model selector are not changed.
- `PLAN`, `SUMMARY` and `SMOL` do not become active consumers because of the UI.
- Search scoring/provider refresh from OMP are not ported; they are not needed for
  the current honest filter/assignment contract.
- Human review remains mandatory for terminology, contrast and keyboard
  feel after live Terminal proof.
