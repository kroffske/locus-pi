# model

## Назначение

`model` — active compatibility wrapper над runtime service `model-settings`.
Он регистрирует `/model-roles` и `/effort`, но не занимает host-owned `/model`
или `/models`. `/model-roles` настраивает persisted routing roles; встроенный
Pi selector по-прежнему владеет обычной сменой модели текущей session.

## Пользовательская поверхность

`/model-roles` открывает один typed `SELECT` flow:

1. **Model** — выбрать модель через настоящий provider filter.
2. **Role** — выбрать route с явной runtime capability.
3. **Effort** — выбрать только поддержанный моделью thinking level.
4. **Receipt** — увидеть сохранённый route или понятную ошибку.

После успешного назначения selector возвращается к model list и сохраняет
inline receipt. Можно сразу выбрать другую модель или роль без повторного
вызова команды. `q` закрывает selector; `Esc`/left возвращает на предыдущий
шаг, а на model list закрывает selector.

Каждый frame имеет явный `[SELECT] Model roles` container. В нём отдельно
показаны:

- `Current session model` — текущая модель Pi session;
- `DEFAULT route` — persisted fallback из model-role config;
- `Routing roles` — сохранённые non-default routes, по одному на строку;
- `Provider filters` — управление списком, а не ещё одна status line;
- `Available roles` — bounded legend всех шести routes, сокращённая на narrow;
- выбранная model/role/effort и inline `[OK]`, `[WARN]` или `[ERROR]` receipt;
- keyboard controls текущего шага.

## Current session и DEFAULT route

`Current session model` и `DEFAULT route` не являются одним значением. Только
назначение `DEFAULT` вызывает `pi.setModel`, затем применяет и проверяет
`pi.setThinkingLevel`, после чего сохраняет route. Если host не принял model
или clamp-нул effort, route не сохраняется молча: selector остаётся usable и
показывает ошибку.

Встроенный host `/model` может позже изменить Current без изменения persisted
`DEFAULT route`. При повторном открытии selector показывает это расхождение
на двух отдельных строках.

Non-default role assignment не меняет session model или session effort. Оно
сохраняет явный `provider/model:effort` route.

## Runtime capability ролей

| Role      | Capability                          | Реальный consumer                                                              |
| --------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `DEFAULT` | `active · session + route fallback` | Current session action и последний fallback всех resolver chains.              |
| `AGENT`   | `active · agents/workflows primary` | Default-loaded `agents` и workflow agent bridge.                               |
| `TASK`    | `fallback · agents/workflows`       | Fallback после `AGENT` для тех же active consumers.                            |
| `PLAN`    | `dormant · beta prompt planning`    | Только disabled beta `prompt-planning`; default-loaded consumer отсутствует.   |
| `SUMMARY` | `dormant · resolver only`           | Resolver contract и tests; default-loaded consumer отсутствует.                |
| `SMOL`    | `fallback-only · summary resolver`  | Fallback в `SUMMARY → SMOL → DEFAULT`; active summary caller пока отсутствует. |

Selector намеренно не выдаёт dormant/resolver-only role за полностью активную
возможность. Полный source map записан в task-local consumer audit T-203.

## Provider filters и responsive layout

`ALL` и provider names являются фильтрами списка. На широком/обычном terminal
они показаны одной подписанной строкой `Provider filters:`. На 48 columns
selector показывает текущий filter и позицию в carousel, например
`Provider filter 2/4: [OPENAI]`. Model window ограничен 8/6/4 строками для
wide/regular/narrow width, а selected row и stage focus сохраняются
deterministically после mutation.

Активный filter выделяется Pi theme token `success`; любая назначенная модель и
её markers (`Current`, `DEFAULT`, `AGENT`, `TASK`, `PLAN`, `SUMMARY`, `SMOL`)
используют тёплый `warning`. Неназначенные model/role identity и текущий cursor
используют `accent` плюс `>`/bold. Цвет не является единственным сигналом:
квадратные labels, role names, filter brackets и cursor marker остаются в plain
projection.

## Capability-backed effort

Pi `0.80.3` model registry сообщает capability через `reasoning` и
`thinkingLevelMap`. Selector использует ту же семантику, что Pi:

- non-reasoning model поддерживает только `off`;
- `null` в `thinkingLevelMap` исключает level;
- `xhigh` показывается только при явном mapping;
- unknown capability fail-closed показывает только `off`;
- legacy `thinking: string[]` остаётся явным compatibility shim.

Официальный Pi API clamp-ит unsupported thinking level. Поэтому
`/model-roles` и `/effort` предварительно проверяют capability, а после host
mutation проверяют фактический result. Unsupported/clamped effort не
представляется успешным apply.

`/effort <level>` меняет только effort текущей session model. `/effort` без
аргумента использует host select с capability-backed options и явным
`[SELECT] Thinking effort` title. Так как host `select` не принимает отдельный
initial-index, extension ставит текущий поддержанный level первым: Enter без
навигации сохраняет текущее значение. Такой idempotent выбор не вызывает
`pi.setThinkingLevel` и возвращает честный `[VIEW]`; `[CHANGE]` остаётся только
для подтверждённой mutation, `[WARN]` — для host clamp, `[ERROR]` — для
invalid/unsupported level или недоступного host API.
Отмена не меняет session effort и не создаёт result block. Команда не пишет
route state и не дублирует typed result отдельным plain notification.
В noninteractive/RPC mode no-arg вызов не имитирует selector: `[WARN]` показывает
текущий/supported effort и recovery `/effort <level>`. Если `/model-roles` не
получил custom UI или configured models, typed read-only fallback различает
`Current session model`, `DEFAULT route` и другие routes, явно сообщает, что
mutation не выполнялась, и не создаёт отдельную host notification.

## Persistence и precedence

Project role store: `.pi/model-roles/config.json`. User fallback:
`~/.pi/agent/model-roles/config.json` или
`$PI_MODEL_ROLES_HOME/model-roles/config.json`.

Effective precedence: `session → settings → project → user`. Runtime Pi не
предоставляет `ctx.settings`; эта ветка остаётся test/compatibility mirror.
Project `null` означает inheritance user value. User config read-only.

Успешный apply также пытается append-нуть session custom entry
`customType="model-roles"`. При `LOCUS_PI_SESSION_STORE=jsonl` extension пишет
`model_role_runtime_event` с requested/current model/effort и честными
`modelApplied`, `thinkingApplied`, `rolePersisted` flags.

## Persistent status

Extension удаляет legacy private key `model-roles` и публикует один
`model.roles` contribution через shared status key `locus`. Contribution
показывает только bounded routing summary/count. Он не повторяет host-owned
current model, effort, cwd, branch, context или cost; полный route остаётся
discoverable в selector.

## Как работает по коду

- `extensions/model/index.ts` — command registration, Pi mutation, persistence,
  runtime evidence и status publication.
- `extensions/model/model-role-selector.ts` — role capability catalog,
  responsive model rows, provider filters и continuous keyboard state.
- `extensions/_shared/model-settings.ts` — parsing, precedence, persistence и
  purpose resolvers.
- `extensions/_shared/operator-ui.ts` — typed selector и command-result
  rendering (`SELECT`, `CHANGE`, `WARN`, `ERROR`).
- `extensions/_shared/operator-status.ts` — bounded shared status registry.

Pi contracts:

- [Extensions: setModel/thinking/custom UI](https://pi.dev/docs/latest/extensions)
- [TUI components and invalidation](https://pi.dev/docs/latest/tui)
- [Custom model capability fields](https://pi.dev/docs/latest/models)

## Package boundary и ограничения

- Entrypoint default-loaded: `./extensions/model/index.ts`.
- Commands: `model-roles`, `effort`; tools: none.
- Hook: `session_start` синхронизирует routing contribution.
- Provider registry, credentials и built-in model selector не меняются.
- `PLAN`, `SUMMARY` и `SMOL` не становятся active consumers из-за UI.
- Search scoring/provider refresh из OMP не портированы; они не нужны для
  текущего честного filter/assignment contract.
- Human review остаётся обязательным для terminology, contrast и keyboard
  feel после live Terminal proof.
