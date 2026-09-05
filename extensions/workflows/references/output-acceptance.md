# Workflow output acceptance

Audience: authors using a strict scalar result and bridge/host maintainers. This file owns the new opt-in output API. The legacy text/schema behavior remains documented in [REFERENCE.md](../REFERENCE.md#dsl-surface-v0).

## API

```js
const route = await agent("Classify the candidate", {
  label: "classify",
  title: "Orders · classification",
  choice: ["dag", "not-a-dag", "unresolved"],
  returnVia: "tool",
  repair: { maxAttempts: 3, clarification: "Reuse the existing evidence; correct the value only." },
});
const value = await agent("Return the exact identifier", {
  label: "identifier",
  output: { type: "string", singleLine: true, maxLength: 200 },
  returnVia: "tool",
});
```

`returnVia: "tool"` accepts exactly one of `choice` or `output`. String output is nonblank; `singleLine` rejects line breaks, not every possible Markdown token. `maxLength` is a positive safe integer up to 500,000; the default is 100,000. The outer existing answer/tool/time bounds also apply. No model-specific fence-stripping parser is added.

`repair.maxAttempts` includes the first proposal or a turn with no proposal, defaults to 2 and is limited to 1..3. Optional clarification is nonblank text up to 4,000 characters. Both option objects are closed. `output` and `repair` without tool return are refused. Tool return does not combine with raw `schema`, `validate`, `handoffs` or transport `attempts` greater than one.

The workflow child alone receives `workflow_return({ value })`. The closure, not tool arguments, owns this call's contract and identity. The tool accepts no file path, call ID or routing target. The first valid proposal is fixed; identical duplicates are idempotent, contradictory second proposals fail the call.

## Same-session lifecycle

The host creates one child session, performs the task and validates the tool proposal. Invalid tool calls receive feedback in that session. If the turn ends without a usable proposal, the host sends bounded clarification to the same session, reusing its history. No fresh worker or second logical workflow call is created for format repair.

After submission, and before a clarification prompt, the host narrows active tools to the return tool and verifies readback. Changes apply to the next model turn: this is not a sandbox, does not roll back a dispatched tool batch, and does not provide exactly-once external effects. Unsupported tool-set readback/restriction fails before the first prompt with `output-contract-unavailable`; there is no silent fresh-session fallback.

Tools, assistant turns and the wall-clock deadline accumulate across clarification. The original outer workflow timeout remains armed. A candidate is committed only when the child finishes successfully; a provider error, cancellation, timeout or budget failure after a proposal still fails. The session is disposed once.

Legacy `choice`, `schema` and `schema + validate` keep their current fresh-session shape repair; ordinary text calls are unchanged. Tool return is opt-in. A semantic `continue` still requires a new worker call and a new conversation.

## Canonical value and evidence

The SDK emits canonical JSON for the accepted scalar; runtime checks that boundary and returns the exact string to workflow code. The ordinary run-owned artifact store records those canonical answer bytes, independently of the model's final narrative. Source does not need filesystem access to persist an accepted value.

`agent_end.outputAcceptance` contains `{ source: "tool", toolName: "workflow_return", attempts }` only on success. `callId`, child session evidence and group `itemPath` bind it to the execution. Missing fresh-execution acceptance receipts fail closed. Replayed calls use recorded validated canonical answers and existing replay provenance; they do not invent a new session receipt.

Choice decisions emit a runtime journal log with `message: "[workflow:choice]"` and `choiceDecision`: `value`, `source: "validated" | "fallback"`, `returnVia: "text" | "tool"`, optional attempts and fallback reason. The transcript shows the source, transport and attempts. Fallback is not ordinary model judgment.

An explicitly declared `choiceFallback` in tool mode applies only to `output-contract-exhausted`. It never turns provider, authorization, cancellation or infrastructure errors into `not-a-dag` or another domain decision. With asymmetric false-negative costs, select an explicit uncertainty value or fail closed. A valid negative classification may still require semantic re-review; output acceptance proves shape, not truth.

## Deliberate limits

This is a scalar acceptance boundary, not a new domain-record database. The source archive does not contain the review's private Airflow catalog workflow/composer, so this change does not claim to migrate that workflow. A catalog needs owner-defined `candidateKey → dagRef → fieldKey`, a complete expected-key set and separate states for unknown, absent, failed and skipped. Do not correlate multiple DAGs by comma-separated position. Use accepted values/evidence as the input to that separately owned integration; an agent-written file is not authoritative merely because its returned scalar was valid.

A conflicting second accepted proposal has `output-contract-conflict`, not exhaustion; it never selects choiceFallback. An explicit `repair` object must supply `maxAttempts`.
