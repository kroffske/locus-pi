# Recovery and continuation are different contracts

Audience: operators recovering a run and authors selecting a handoff. Ordinary Repair + Continue remains owned by [Resume and replay](../REFERENCE.md#resume-and-replay); this file owns the conservative explicit interrupted-run extension.

| Mechanism             | Boundary                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| Semantic continuation | Same run, a verifier selects another fresh worker with exact goal/result/feedback  |
| Format clarification  | Same logical call and same child session, only the output contract is corrected    |
| Replay                | Rerun source, reuse a matching recorded call prefix, then execute a fresh suffix   |
| Human continuation    | Terminal awaiting_operator, verified artifacts and operator answer start a new run |
| Generated workflow    | New source is authored before execution; not a completion mechanism by itself      |

## Explicit interrupted-run recovery

`workflow({ ..., resumeFromRunId, recoverInterrupted: true })` is an opt-in admission path for a missing terminal `result.json`. It is not a general retry switch, not the default Repair + Continue route, and not a promise to resume arbitrary in-flight effects. It requires the structured tool; no new slash-command flag is introduced.

New root runs persist a host-owned launch binding before child work, with target/source snapshot, physical workspace identity and an exact fingerprint of input, caller items, resolved budgets and no-operator mode. Old diagnostic/runtime runs without that fingerprint remain readable but do not gain hard-crash recovery authority.

Admission requires the identical target, source and caller inputs; a healthy self-contained orchestration-only source with no imports; no saved children or grouped execution; a complete labelled serial journal/replay prefix; and no started-but-unconfirmed call, error, damaged/truncated record or clock/random recording. A present-but-corrupt result is not treated as a missing result. The existing workspace lease must be acquired; the evidence is checked again under that lease. Live or unverifiable lease owners are not silently taken over.

No terminal success envelope is manufactured. An admission-only metadata projection has `ok:false`, is never persisted as a result, and is used solely to validate the existing workspace/replay path. The new run produces its own real terminal result. Under this mode a mismatch inside the confirmed prefix throws instead of executing that prefix afresh, and ending before consuming the confirmed prefix is an error. Ordinary repaired-source replay remains unchanged when this flag is absent.

This conservative first version refuses parallel/nested runs and unconfirmed effects. That is narrower than a general durable execution engine, deliberately. A child may have changed a file before its completion record was durable; runtime cannot infer exactly-once semantics for that window. Use idempotency/receipts or operator reconciliation, not blind continuation. Do not delete or edit runtime evidence to force admission.

A confirmed cached answer does not recreate files or recheck an externally changed repository. Do not change the workspace, provider routes or agent profiles while relying on old evidence. Require fresh verification before irreversible external effects. Filesystem/power-loss durability and real Pi execution require their own acceptance evidence; process-kill prefix tests do not establish those stronger guarantees.

## Human continuation

`awaitOperator({ reason, operatorHandoff? })` declares a terminal disposition and does not pause the JavaScript stack. Return immediately. A resumable handoff places references under `operatorHandoff.continuationArtifactRefs`, not a top-level `artifactRefs` property. The handoff service validates claims, target/workspace identity and artifact digests, then starts a new run with the real operator answer. It does not synthesize approval.

`continuation` and `resumeFromRunId` remain mutually exclusive. In `noOperator` mode the gate fails closed. A reason-only awaiting_operator stop explains the blocker but is not automatically a fully bound handoff. See the [compatibility example](examples/human-continuation.workflow.mjs); standard source must not claim permission to inspect arbitrary artifact objects.
