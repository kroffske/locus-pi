# devext-doctor

## Назначение

`devext-doctor` показывает короткий health/status report по текущему reduced default package. Он нужен, чтобы быстро проверить, что установленная сборка видит активные по умолчанию extensions и что OMP-port backlog не перепутан с product-ready surface.

## Почему он есть в проекте

После установки или smoke-запуска разработчику нужен один простой operator command, который показывает active defaults, active compatibility wrappers, disabled compatibility wrappers, OMP-owned ports, redesign-later surfaces, split-required bundles, fixtures и deleted legacy surfaces. `devext-doctor` не пытается заменить тесты, но дает быстрый ответ на вопрос: загружен ли честный reduced surface, а не старый набор локальных дублей.

## Пользовательская поверхность

- Пользователь вызывает команду `/devext doctor`. Extension выводит typed `VIEW` `Extension doctor` с `status:ok` и `diagnostic`, count/preview строками по default surface, recovery/actions и явной границей: это snapshot inventory/manifests, а не runtime proof перечисленных или disabled extensions.
- RPC получает отдельную compact projection не длиннее host `string[]` budget: evidence boundary, docs pointer и actions сохраняются. Task-lifecycle RPC так же сохраняет `dryRun:true`, no-mutation evidence и `locus task update` path вместо скрытого truncation.
- Перед render `/devext doctor` общий command UI lifecycle очищает stale transient widgets/status от предыдущих commands, чтобы старые строки не оставались рядом с новым doctor output.
- После `/devext doctor` следующий unrelated input, например `ls`, очищает widget `devext-doctor`, чтобы старые строки не выглядели текущим статусом.
- Пользователь вызывает команду `/devext reload`, чтобы выполнить официальный Pi reload flow через command-context `ctx.reload()`. До вызова показывается typed `RUN`: Pi владеет completion, а старый command frame не является доказательством успеха. Недоступный host даёт `WARN` с `/reload`/restart recovery; исключение даёт `ERROR`, а не ложный success.
- Пользователь вызывает команду `/devext task-lifecycle <task-id> <target-status>`, чтобы получить read-only dry-run план перехода по `.tasks/index.json`. Команда строит typed `VIEW` или `WARN` напрямую из structured `TaskLifecyclePlan`, маркирует `dryRun:true`, показывает preconditions/evidence boundary и authoritative `locus task update` mutation path. Она не мутирует `.tasks` и не трогает session todos.
- Неизвестный `/devext <action>` возвращает typed `WARN`, явно говорит, что diagnostic/mutation/reload не запускались, и оставляет полную usage recovery. Он не растворяется в равновесном белом notification text.
- Агент может вызвать tool `devext_reload`. Tool пробует прямой `ctx.reload()` только если host когда-нибудь экспонирует reload method в tool context. В текущем Pi host reload доступен только command-context handler’ам, поэтому tool fail-closed с инструкцией выполнить `/devext reload` или built-in `/reload` вручную в interactive command input.

## Как работает по коду

Entrypoint `extensions/devext-doctor/index.ts` регистрирует команду `devext` и tool `devext_reload`. Handler читает command text через `_shared/pi-api.getCommandText`; если аргумент пустой, он трактуется как `doctor`. `/devext reload` вызывает официальный command-context `ctx.reload()` после `RUN` receipt; Pi docs предупреждают, что код после reload продолжает выполняться в старом call frame, поэтому receipt не утверждает completion. Если host не экспортирует `ctx.reload`, command fail-closed показывает `WARN` с просьбой выполнить `/reload` вручную или перезапустить Pi; thrown error показывает `ERROR`. `/devext task-lifecycle <task-id> <target-status>` парсит exact `task-id` и `target-status`, зовет `_shared/task-bridge.planTaskLifecycleTransition()`, затем строит typed block из structured plan без повторного разбора format string.

Shared lifecycle planner читает `.tasks/index.json` через `loadTaskBridgeSnapshot(projectRoot)`, ищет task по exact `id`, проверяет разрешенные dry-run transitions и, если цель `done`, дополнительно требует `qa.md` с word `ACCEPTED` и реальный `## Closure` section в `task.md`. Planner остается dry-run only и не пишет файлы.

Функция `doctorBlock()` строит typed block из общего inventory в `extensions/_shared/extension-inventory.ts`. Этот inventory фиксирует product-visible `currentStatus` и ownership bucket для retained и deleted extensions. Normal doctor output остается ограниченным: active defaults, compatibility wrappers, OMP backlog, redesign/split buckets, fixtures/deleted legacy surfaces выводятся как counts и короткие previews вместо длинных raw comma-list dump lines. Command registration идет через `extensions/_shared/command-ui.ts`, поэтому stale transient cleanup больше не hard-code-ит чужие widget keys внутри `devext-doctor`.

- Entrypoint: `./extensions/devext-doctor/index.ts`
- Manifest: `extensions/devext-doctor/manifest.json`
- Commands: `devext doctor`, `devext reload`, `devext task-lifecycle <task-id> <target-status>`
- Tools: `devext_reload`
- Hooks: `input`
- Permissions: fs.read=`.tasks/index.json`, `.tasks/**/qa.md`, `.tasks/**/task.md`; fs.write=none, subprocess=none, network=none, browser=false, models=false, ui=`setWidget`, `setStatus`, `notify`
- State: extension читает shared extension inventory, `.tasks/index.json` task bridge snapshot и task workspace files для dry-run planner, но ничего не сохраняет.
- Tests: `tests/integration/command-ui-lifecycle.test.ts`, `tests/shared/task/tasks-bridge.test.ts`, `tests/shared/session/session-core-jsonl.test.ts`, `tests/integration/public-registration.test.ts`, `tests/extensions/agents/agent-observer.test.ts`
- Review: status=reviewed, source=write-from-scratch, reviewedBy=locus-pi, reviewedAt=2026-05-31, risk=low

## Ограничения и риски

`devext-doctor` — это status summary, а не глубокая self-test диагностика. Он не проверяет commands, hooks, UI permissions или реальную способность disabled extension выполнить свои сценарии. Normal output намеренно помещается в один 80x24 TUI viewport и поэтому показывает counts/previews, а не полный inventory dump. За подробностями нужно читать `docs/extension-index.md`, manifests и focused tests.

`/devext task-lifecycle <task-id> <target-status>` тоже остается dry-run only. Он не мутирует `.tasks`, не автосинхронизирует todo state и не заменяет `locus task update`, который остается authoritative mutation/closure path. Если report выглядит нормально, это означает только то, что текущий process видит shared inventory для default/backlog buckets; lifecycle proof отдельно ограничен dry-run task bridge.

`/devext reload` может работать только после того, как эта версия extension уже загружена. Он не может исправить самую первую старую сессию, где `devext_reload` ещё не зарегистрирован; для этого всё равно нужен ручной `/reload` или restart. В текущем Pi host `devext_reload` из model tool context не может сам выполнить reload и не имитирует успех; он возвращает blocked/error result вместо отправки slash-command в чат.

## Решение

Решение: `keep`. Extension полезен как operator surface после установки и во время smoke-проверок. Его можно расширять отдельными проверками, но текущая форма должна оставаться короткой и безопасной.
