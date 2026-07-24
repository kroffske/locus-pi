# Source audit: model

Decision: copy-after-audit, active project-config-backed compatibility wrapper.
The extension owns `/model-roles` and `/effort` but never registers `/model` or
`/models`, because Pi/OMP own that built-in namespace.

## Upstream and official evidence

OMP source evidence:

- `oh-my-pi:packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `oh-my-pi:packages/coding-agent/src/modes/controllers/input-controller.ts`
- `oh-my-pi:packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `oh-my-pi:packages/coding-agent/src/session/agent-session.ts`
- `oh-my-pi:packages/coding-agent/src/extensibility/extensions/types.ts`
- `oh-my-pi:LICENSE`

Official Pi evidence:

- [Extensions](https://pi.dev/docs/latest/extensions) — `ctx.ui.custom`,
  `pi.setModel`, `pi.getThinkingLevel`, `pi.setThinkingLevel`; thinking changes
  are clamped to model capability.
- [TUI](https://pi.dev/docs/latest/tui) — component input, rerender and
  invalidation contract.
- [Custom models](https://pi.dev/docs/latest/models) — `reasoning` and
  `thinkingLevelMap` capability fields.

Installed host evidence: `@earendil-works/pi-coding-agent@0.82.0` and
`@earendil-works/pi-ai@0.82.0`. Pi AI's
`getSupportedThinkingLevels(model)` returns `off` for non-reasoning models,
excludes `null` mappings and exposes `xhigh` only when mapped.

License note: OMP checkout is MIT-licensed. No OMP selector implementation was
copied. OMP was used as behavioral/contrast benchmark; local state machine,
typed presentation and persistence remain locus-pi-owned.

## Retained contract

- Active `model` extension registers `/model-roles` and `/effort`, no tools.
- `/model-roles` uses one continuous custom selector: model → role → effort →
  inline receipt. Successful apply returns to the model list without closing
  the selector; assigned routes render one per line with a shared warning-state
  color for both role marker and model value.
- `/effort` keeps Pi's host-owned selection surface with an explicit `[SELECT]`
  title. The host API exposes no initial-index option, so the current supported
  level is placed first. Confirming it is an idempotent `[VIEW]`; actual
  mutations remain `[CHANGE]`, with `[WARN]`/`[ERROR]` for degraded outcomes.
- Missing custom UI/configured models use a typed read-only `/model-roles`
  fallback; noninteractive no-arg `/effort` returns an explicit-level recovery
  and never opens a synthetic selector.
- Cancelling `/effort` performs no mutation and emits no settled-result block.
- Provider labels are actual filters; narrow mode uses a filter carousel/count.
- `Current session model` and persisted `DEFAULT route` remain distinct.
- Only `DEFAULT` applies `pi.setModel` and verified session effort. Other roles
  save route effort without changing the session.
- Route assignments persist to project `.pi/model-roles/config.json`.
- User config remains read-only fallback; effective precedence is
  `session → settings → project → user` with project-null inheritance.
- Optional JSONL runtime event records requested/current model and effort plus
  apply/persist truth.
- Status uses shared `locus` key through contribution `model.roles`; legacy
  private `model-roles` status is cleared.

## Consumer audit (T-203)

- `DEFAULT`: active current-session action and final resolver fallback.
- `AGENT`: active primary route in default-loaded agents and workflow bridge.
- `TASK`: active fallback inside the same agent/workflow consumer chain.
- `PLAN`: beta-only prompt-planning consumer; dormant in default package.
- `SUMMARY`: resolver contract only; no default-loaded caller.
- `SMOL`: fallback inside dormant summary chain; no independent active caller.

Those labels are rendered in the selector. Persistability does not imply an
active consumer.

## Local differences from OMP

- Uses `/model-roles`, not OMP/Pi built-in `/model`.
- Uses shared locus-pi typed operator grammar and shared bounded status
  registry; `/effort` reuses Pi's selector instead of copying OMP's selector.
- Uses explicit capability labels for dormant/fallback roles.
- Keeps project JSON route config and read-only legacy user fallback.
- Leaves OMP search scoring, provider refresh and full built-in model selector
  behavior upstream instead of reimplementing them.

## Known gaps

- Native Terminal contrast, physical keyboard/layout and light/plain theme
  remain human/T-207 acceptance surfaces.
- `PLAN`, `SUMMARY`, and `SMOL` need real default-loaded consumers before their
  capability labels can be promoted from dormant/fallback-only.
