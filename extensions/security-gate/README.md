# security-gate

`security-gate` records audit-only observations for tool calls.

## Surface

```text
/security-audit [limit]
```

The `tool_call` hook classifies calls and stores a bounded in-memory audit ring. Dangerous-looking calls are marked `delegated-to-pi`; the hook does not block them. Approval, prompt, and deny decisions remain owned by Pi and the user's approval settings.

`/security-audit` renders recent observations with bounded, redacted targets. The ring resets with the process and is not durable proof of enforcement.

## Non-goals

- not an approval-policy system;
- not a sandbox, malware scanner, or secret scanner;
- not a replacement for Pi approvals;
- not a vulnerability-reporting channel.

Report suspected vulnerabilities through GitHub private vulnerability reporting, never through a public issue.

## Implementation

- Entrypoint: `extensions/security-gate/index.ts`
- Classification and ring: `extensions/security-gate/permissions.ts`
- Manifest: `extensions/security-gate/manifest.json`
