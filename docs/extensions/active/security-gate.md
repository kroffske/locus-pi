# security-gate

## Purpose

`security-gate` is a default-loaded Locus-specific audit surface for tool calls. It registers only `/security-audit` and one `tool_call` hook that classifies calls, writes local audit events, and does not block execution itself.

## Who uses it

- The operator runs `/security-audit [limit]` to look at recent local audit events.
- All tool calls pass through the `tool_call` hook; approval, prompt, and deny decisions remain with the Pi native approval layer and the user's `tools.approval.*` settings.

## Surface

- Command: `/security-audit`
- Hook: `tool_call`
- Tools: none
- It does not register slash commands for approval UI parity or model-callable tools.

## How it works

Entrypoint `extensions/security-gate/index.ts` calls its own `security-gate/permissions.classifyToolCall` on every `tool_call` event. If the call is classified dangerous, the hook writes an audit event with `userDecision: "delegated-to-pi"` and returns without a block result. If the call is safe, the hook writes an allow audit event and lets execution continue. The active code path is audit-only by design and does not claim full OMP approval parity.

Enforcement is delegated to Pi original; this extension records observations and never blocks tool execution itself.

`/security-audit [limit]` reads the in-memory audit ring from `security-gate/permissions.getAuditEvents()` and renders typed `VIEW` chrome with `audit-only` and `Pi enforcement` badges. By default the TUI selects up to 20 newest observations, and an explicit limit is capped at 50; the RPC passive projection shows the three newest rows plus an honest `+N hidden`, so recovery stays within the host `string[]` budget. Rows have the columns time, severity, decision, action, tool and target; output is newest-first. `WARN` means only a recorded `delegated-to-pi`; an ordinary observed allow stays `INFO`. The target is stripped of terminal controls, redacts known secret forms and is width-bounded. This is a local review surface only, not OMP approval UI parity and not durable enforcement proof.

## Limitations

- `security-gate` is not an approval-policy system.
- It does not write durable `decision` entries and does not own prompt/deny decisions.
- It does not claim full OMP approval parity or global registry interception.
- The audit ring is in-memory and resets with the process.
- Compact output intentionally omits raw args and complete long targets; source evidence remains only in the process-local audit ring.

## Code map

- Entrypoint: `./extensions/security-gate/index.ts`
- Manifest: `extensions/security-gate/manifest.json`
- Commands: `security-audit`
- Tools: none
- Hooks: `tool_call`
- Permissions: fs.read=none, fs.write=none, subprocess=none, network=none, browser=false, models=false, ui=`setWidget`
- State: in-memory audit events only
- Review: status=reviewed, source=write-from-scratch, reviewedBy=locus-pi, reviewedAt=2026-06-17, risk=critical
