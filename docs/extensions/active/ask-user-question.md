# ask-user-question

## Назначение

`ask-user-question` дает агенту human-in-the-loop primitive: агент может задать пользователю один или несколько OMP-compatible вопросов через UI и получить structured answer. Extension нужен для случаев, где продолжать без выбора человека нельзя или небезопасно.

## Почему он есть в проекте

Проекту нужна явная граница между автономной работой агента и решениями пользователя. OMP уже реализует правильный contract для такого выбора: `questions[]`, `recommended`, `multi` и автоматический `Other`. Локальная версия использует Pi `ctx.ui.custom`, когда он доступен, чтобы показать bounded checklist/selector с видимым `[ ]` / `[x]`, toggle behavior, explicit `Done selecting`, option navigation и left/right previous/next navigation между вопросами. Selector помещен в typed `SELECT` frame; custom text открывается как `[INPUT] Ask custom response`; результат отделен как `[RESULT] Ask` или `[ERROR] Ask`. Если host не экспонирует `ctx.ui.custom`, extension честно fallback-ится к встроенному `select` / `editor` flow с теми же role labels в заголовках.

## Пользовательская поверхность

- Агент вызывает primary tool `ask`, когда ему нужен ответ от пользователя. Параметр `questions` содержит один или несколько вопросов с `id`, `question`, `options`, optional `multi` и optional `recommended`.
- UI автоматически добавляет `Other (type your own)`, поэтому caller не должен передавать этот вариант сам.
- Legacy tool `askUserQuestion` сохранен для старых callers. Он преобразует старую схему `question` / `kind` / `options` в новый `ask` flow и сохраняет redaction behavior для `sensitivity=secret`.
- Extension не регистрирует slash-команду: default package surface exposes only the tool/API path, чтобы QA-команда не засоряла пользовательский command list.

## Как работает по коду

Entrypoint `extensions/ask-user-question/index.ts` регистрирует TypeBox-backed tool `ask` и compatibility tool `askUserQuestion`. Handler валидирует параметры через `_shared/validation.validateParams`, затем вызывает OMP-compatible flow.

Primary `ask` использует OMP-shaped schema: single question возвращает `selectedOptions` и optional `customInput`, multi-question возвращает `details.results[]` и OMP-style text summary вида `id: value`, `id: [a, b]` или `id: "custom"`. `recommended` добавляет UI suffix ` (Recommended)`, который затем снимается из result. Для `multi=true` adapter показывает checkbox-style select-loop с `[ ]`, `[x]`, `Done selecting` и `Other (type your own)`. `Other (type your own)` открывает editor. When `ctx.ui.custom` is available, the bounded custom overlay handles option navigation, toggle behavior, explicit finish, and multi-question previous/next navigation; when custom UI is missing, the legacy select/editor fallback remains in place. Legacy `askUserQuestion` после ответа применяет `_shared/redaction.redactForSensitivity`: for `secret` значение не возвращается в `details.value`, а visible answer редактируется. Официальный Pi dialog contract (`string | undefined`) нормализуется в `_shared/operator-input.ts`; известная старая object-shaped форма поддерживается только как compatibility branch.

Extension пишет developer event `ask:answered` and durable `decision` entry through `_shared/human-control.recordDecision`. При `LOCUS_PI_SESSION_STORE=jsonl` decision попадает в `.locus/runtime/session-state.jsonl`; Pi custom entry с типом `decision` остается compatibility trail. Escape из реального interactive prompt записывается как cancelled decision. `json`, `print` и explicit no-UI host возвращают `unavailable` без ложной записи о человеческой отмене.

- Entrypoint: `./extensions/ask-user-question/index.ts`
- Manifest: `extensions/ask-user-question/manifest.json`
- Commands: none
- Tools: `ask`, `askUserQuestion`
- Hooks: none
- Permissions: fs.read=none, fs.write=`.locus/runtime/session-state.jsonl`, subprocess=none, network=none, browser=false, models=false, ui=`select`, `input`, `editor`, `custom`
- State: answers and cancellations записываются как `decision` session entries; developer event `ask:answered` остается lightweight event trail.
- Review: status=reviewed, source=copy-after-audit, reviewedBy=locus-pi, reviewedAt=2026-06-01, risk=medium

## Ограничения и риски

Unit smoke covers custom checkbox toggle, explicit `Done selecting`, option navigation, previous/next multi-question navigation, 146/80/48-column rendering, RPC fallback, cancellation decision recording, no-UI behavior, and legacy redaction / durable decision recording. The current bounded custom UI is still a plain-text Pi overlay, not the exact OMP renderer. Hosts without `ctx.ui.custom` fall back to the built-in `select` / `editor` path, so parity there is limited by host capability. The broader `_shared/pi-api.ts` dialog-type repair remains deferred.

## Решение

Решение: `compat-wrapper`, active by default. Extension uses OMP-compatible `ask` contract, keeps `askUserQuestion` only as a legacy alias, and exposes a bounded custom UI when Pi supports it.
