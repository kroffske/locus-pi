# security-gate

## Назначение

`security-gate` — default-loaded Locus-specific audit surface for tool calls. Он регистрирует только `/security-audit` и один `tool_call` hook, который классифицирует calls, пишет local audit events и не блокирует execution сам.

## Кто использует

- Оператор вызывает `/security-audit [limit]`, чтобы посмотреть recent local audit events.
- Все tool calls проходят через `tool_call` hook; approval, prompt и deny решения остаются за Pi native approval layer и пользовательскими `tools.approval.*` настройками.

## Поверхность

- Command: `/security-audit`
- Hook: `tool_call`
- Tools: none
- It does not register slash commands for approval UI parity or model-callable tools.

## Как это работает

Entrypoint `extensions/security-gate/index.ts` calls shared `_shared/permissions.classifyToolCall` on every `tool_call` event. If the call is classified dangerous, the hook writes an audit event with `userDecision: "delegated-to-pi"` and returns without a block result. If the call is safe, the hook writes an allow audit event and lets execution continue. The active code path is audit-only by design and does not claim full OMP approval parity.

Enforcement is delegated to Pi original; this extension records observations and never blocks tool execution itself.

`/security-audit [limit]` reads the in-memory audit ring from `_shared/permissions.getAuditEvents()` and renders typed `VIEW` chrome with `audit-only` and `Pi enforcement` badges. TUI по умолчанию выбирает до 20 newest observations, explicit limit ограничен 50; RPC passive projection показывает три newest rows и честный `+N hidden`, чтобы recovery оставался внутри host `string[]` budget. Строки имеют колонки time, severity, decision, action, tool and target; output идёт newest-first. `WARN` означает только recorded `delegated-to-pi`; обычный observed allow остаётся `INFO`. Target очищается от terminal controls, redacts known secret forms and is width-bounded. Это local review surface only, не OMP approval UI parity и не durable enforcement proof.

## Ограничения

- `security-gate` is not an approval-policy system.
- It does not write durable `decision` entries and does not own prompt/deny decisions.
- It does not claim full OMP approval parity or global registry interception.
- The audit ring is in-memory and resets with the process.
- Compact output intentionally omits raw args and complete long targets; source evidence remains only in the process-local audit ring.

## Карта кода

- Entrypoint: `./extensions/security-gate/index.ts`
- Manifest: `extensions/security-gate/manifest.json`
- Commands: `security-audit`
- Tools: none
- Hooks: `tool_call`
- Permissions: fs.read=none, fs.write=none, subprocess=none, network=none, browser=false, models=false, ui=`setWidget`
- State: in-memory audit events only
- Review: status=reviewed, source=write-from-scratch, reviewedBy=locus-pi, reviewedAt=2026-06-17, risk=critical
