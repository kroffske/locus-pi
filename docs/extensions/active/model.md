# model

## Purpose

`model` — active compatibility wrapper over the `model-settings` runtime service.
It registers `/model-roles` and `/effort`, but does not take over the host-owned
`/model` or `/models`. `/model-roles` configures persisted routing roles; the
built-in Pi selector still owns ordinary model switching for the current session.

## User Surface

`/model-roles` opens a single typed `SELECT` flow:

1. **Model** — pick from the full model list; use `Tab` to cycle an optional provider filter.
2. **Action** — choose the `Set as …` route for that model.
3. **Effort** — pick only a thinking level supported by the model.
4. **Receipt** — see the saved route or a clear error.

After a successful assignment the selector returns to the model list and keeps
the inline receipt. Another model or role can be picked right away without
invoking the command again. `q` closes the selector; `Esc`/left returns to the
previous step, and on the model list it closes the selector.

Every frame has an explicit `[SELECT] Model roles` container. Inside it, the
following are shown separately:

- `Current session model` — the current model of the Pi session;
- `DEFAULT route` — the saved main-model choice made by `Set as DEFAULT`;
- `Routing roles` — saved non-default routes, one per line;
- `Models` — the full model list plus the optional `Tab`-cycled provider filter;
- the selected model/role/effort and an inline `[OK]`, `[WARN]` or `[ERROR]` receipt;
- the keyboard controls of the current step.

## Current session and DEFAULT route

`CURRENT` is the main Pi session's live model. `Set as DEFAULT` changes that
model, then applies and verifies
`pi.setThinkingLevel`, and only then saves the route. If the host did not accept
the model or clamped the effort, the route is not saved silently: the selector
stays usable and shows the error.

The built-in host `/model` can later change `CURRENT` without rewriting the
saved `DEFAULT` choice. The saved value remains persistence evidence, not a
fallback used to replace the live model for an agent.

A non-default role assignment does not change the session model or the session
effort. It saves an explicit `provider/model:effort` route.

Since T-129 those routes are **executed**, not merely recorded: an agent whose
frontmatter names a role, a workflow stage declaring `modelRole`, and
`/agent run` all create the child session with the model the role resolves to. A
role nothing assigns degrades to the session model and the degradation is
recorded in the run evidence; a role assigned to a `provider/id` this host cannot
resolve fails the call by name.

Two consequences worth stating plainly. First, an agent profile with no
`model:` uses `AGENT`; if `AGENT` is unassigned, it inherits `CURRENT`. It does
not fall through to `TASK` or the saved `DEFAULT` choice. A profile that
explicitly names `TASK` still uses `TASK`. Second, an agent whose frontmatter still writes its tier in
the pre-tier `pi/<role>` namespace is read as that role rather than as a provider
named `pi`, so a catalog copied from an older release keeps working; the
degradation note names the spelling to fix.

## Runtime capability of roles

| Role      | Capability                             | Actual consumer                                                                    |
| --------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `DEFAULT` | `active · main/current model`          | Changes the main session model and saves that choice; it is not an agent fallback. |
| `AGENT`   | `active · model-less agents/workflows` | Selects the child model when an agent profile declares no model.                   |
| `TASK`    | `active · explicit task role`          | Selects the child model only when a profile or workflow explicitly names `TASK`.   |
| `PLAN`    | `dormant · beta prompt planning`       | Only the disabled beta `prompt-planning`; no default-loaded consumer.              |
| `SUMMARY` | `dormant · resolver only`              | Resolver contract and tests; no default-loaded consumer.                           |
| `SMOL`    | `fallback-only · summary resolver`     | Fallback in `SUMMARY → SMOL → DEFAULT`; no active summary caller yet.              |

The selector deliberately does not present a dormant/resolver-only role as a
fully active capability. The full source map is recorded in the task-local
consumer audit T-203.

## Provider filters and responsive layout

`ALL` and provider names are optional list filters. The selector opens on the
full model list; `Tab` cycles filters while arrow keys remain dedicated to model
navigation. At 48 columns the active filter includes its carousel position. The
model window is bounded to 8/6/4 lines for wide/regular/narrow width, and the
selected row and stage focus are kept deterministically after a mutation.

The active filter is highlighted with the Pi theme token `success`; any assigned
model and its markers (`Current`, `DEFAULT`, `AGENT`, `TASK`, `PLAN`, `SUMMARY`,
`SMOL`) use the warm `warning`. Unassigned model/role identity and the current
cursor use `accent` plus `>`/bold. Color is not the only signal: square labels,
role names, filter brackets and the cursor marker remain in the plain
projection.

## Capability-backed effort

The Pi `0.82.0` model registry reports capability through `reasoning` and
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

- `extensions/model/index.ts` — entrypoint; registers `/model-roles` and
  `/effort` with their UI lifecycle taxonomy and wires the `session_start`
  status sync. Wiring only.
- `extensions/model/role-command.ts` — the `/model-roles` command: opens the
  inline selector or falls back to the typed read-only block.
- `extensions/model/role-apply.ts` — applying a chosen route: validates,
  mutates the Pi session, and persists it.
- `extensions/model/role-evidence.ts` — the session custom entry and
  `model_role_runtime_event` runtime-store record left behind by an assignment.
- `extensions/model/effort-command.ts` — the `/effort` pipeline: parses,
  validates against model capability, mutates and verifies the thinking level.
- `extensions/model/operator-surface.ts` — the ctx-bound reads/writes behind
  the `model.roles` status lane.
- `extensions/model/operator-ui.ts` — pure `OperatorBlock` builders for
  `/effort` outcomes and the read-only `/model-roles` fallback.
- `extensions/model/model-role-selector.ts` — role capability catalog,
  responsive model rows, provider filters and continuous keyboard state.
- `extensions/_shared/model/model-settings.ts` — parsing, precedence, persistence and
  purpose resolvers.
- `extensions/_shared/operator/operator-ui.ts` — typed selector and command-result
  rendering (`SELECT`, `CHANGE`, `WARN`, `ERROR`).
- `extensions/_shared/operator/operator-status.ts` — bounded shared status registry.

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
