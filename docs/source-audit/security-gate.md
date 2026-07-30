# Source audit: security-gate

Decision: write-from-scratch, active audit-only observer. The current default extension registers `/security-audit` and a narrow `tool_call` hook that audits safe calls and marks classified dangerous calls as delegated to Pi approval. It does not block execution itself. Historical beta code is excluded from the clean release.

Local source paths:

- `extensions/security-gate/index.ts`
- `extensions/security-gate/manifest.json`
- `extensions/security-gate/permissions.ts`
- `tests/shared/security/security.test.ts`
- `docs/extensions/active/security-gate.md`

License / attribution:

- No upstream code was copied into the active hook.
- Pi extension API semantics were used only as the local host contract.
- The active implementation is Locus-owned; private history retains older provenance.

Behavior contract:

- Safe/read-only calls are audited as `allow` and pass through.
- Classified dangerous calls are audited as `allow` with `userDecision: "delegated-to-pi"` and pass through to Pi native approval behavior.
- `/security-audit [limit]` reads the in-memory audit ring newest-first and shows
  a bounded typed diagnostic with literal decision/action facts, derived
  INFO/WARN severity, redacted width-bounded targets and `+N hidden`.
- The T-206 operator presentation is local/write-from-scratch. It reuses the
  shared operator frame but leaves classifier, audit ring and Pi enforcement
  ownership unchanged; no OMP approval UI code or semantics were copied.
- Durable approval journaling is not owned by `locus-pi`.

Known gaps:

- No Locus-owned approval UI layer.
- No global tool registry interception.
- Audit history is in-memory only and resets with the process.
