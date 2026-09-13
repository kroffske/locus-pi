# Workflow output acceptance

Audience: authors using a strict scalar or shaped result and bridge/host maintainers. This file owns the output API. It is no longer opt-in: same-session acceptance is the ONLY way a shaped value reaches workflow code. The text-parsed transport — a shape block appended to the prompt, the final message parsed as JSON, a fresh child spawned to repair the format — has been deleted. Plain `agent(prompt)` still returns the child's exact full text and is untouched.

## The principle

Stated here once. Every other workflow document links to this section instead of
repeating it, so there is one place to correct if it ever changes.

1. **The runtime never rejects or truncates an answer because of its own size policy.**
   A bound on answer length, item count or artifact size is either a consumer's declared
   contract, a provider's real API parameter, or it does not exist. A removed bound is
   not replaced by a smaller number, and not by a prompt asking the child to "keep it
   under N characters" — that is the same policy rewritten in English, and it fails the
   same way: the work is already paid for when the bound bites.
2. **Budgets stop spending, not answers.** Time, turns, tool calls and agents are
   resolved from the approved launch defaults and explicit author/operator settings,
   checked before the next spend, and printed as `unbounded` where neither sets a value. A run that ends on one is _stopped by
   budget_ — a statement about what it may still spend, never a verdict on the answers
   it already produced, all of which stay stored and readable. See
   [run budget](../REFERENCE.md#run-budget) for the axes.
3. **A capability that cannot be honoured is refused before the child starts.** If a
   transport or model cannot carry a declared contract, the call fails by name up front
   (`output-contract-unavailable`) rather than imitating the capability by grading the
   finished answer.

Three things stay separate throughout, and the journal keeps them separate: whether
execution FINISHED, whether the result is ACCEPTABLE to its consumer, and whether the
stored data is AVAILABLE. An invalid result is still stored and still readable.

## API

```js
const route = await agent("Classify the candidate", {
  label: "classify",
  title: "Orders · classification",
  choice: ["dag", "not-a-dag", "unresolved"],
  repair: { maxAttempts: 3, clarification: "Reuse the existing evidence; correct the value only." },
});
const value = await agent("Return the exact identifier", {
  label: "identifier",
  // Both bounds name a real consumer: the identifier is one line in a status row, and
  // the record it is written into refuses more than 200 characters.
  output: { type: "string", singleLine: true, maxLength: 200 },
});
const verdict = await agent("Check the actual result against the original goal", {
  label: "verifier",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "summary"],
    properties: {
      decision: { type: "string", enum: ["complete", "needs-work", "unknown"] },
      // Present and non-blank, with no ceiling: nothing downstream breaks on a longer
      // summary, and the prompt is where its length is asked for.
      summary: { type: "string", minLength: 1, nonBlank: true },
    },
  },
  repair: { maxAttempts: 2 },
});
const units = await agent("Return complete independent work instructions", {
  label: "discover",
  // Counts, not sizes: zero units leaves the next stage nothing to do, and this caller
  // has exactly 20 workers to give them to. Drop `maxItems` when no such consumer
  // exists — a queue is not too long merely because it is long.
  handoffs: { minItems: 1, maxItems: 20 },
});
```

A shaped call declares exactly one of `choice`, `output`, `schema` or `handoffs`; declaring two is refused by name before any child starts. String output is nonblank; `singleLine` rejects line breaks, not every possible Markdown token. `maxLength` is an optional positive safe integer with **no package default**: omit it and the value is accepted at whatever length the work needs. Declare it only when a real consumer cannot take more — a status line, a filename, a field in someone else's record — because the number enters the child's contract as a promise, not as a guess. The outer tool/time bounds still apply.

`returnVia` is gone as a decision. `returnVia: "tool"` is accepted for one release and journaled as a redundant, ignored option; `returnVia: "text"` is refused by name, because it selects a transport that no longer exists.

`schema` uses the supported keyword subset and its validator. `handoffs` states an array of complete non-blank text units: `minItems` defaults to 0, `maxItems` may be omitted entirely, and there is no per-item character bound — `maxItemChars` is refused by name, because truncating one work unit to a guessed width destroys the work rather than protecting a consumer. A `maxLength` on a schema-shaped contract bounds the canonical JSON only when the author declared one; the runtime derives no allowance of its own and performs no size arithmetic before the call. The value is the JSON value itself: a string that contains JSON is a shape mismatch and is corrected in the same session, not parsed. No fence stripping or prose parsing exists anywhere on this path.

`repair.maxAttempts` counts submissions, including the first proposal or a turn with no proposal. It defaults to **2 — one proposal plus exactly one same-session correction turn** — and has no upper bound beyond being a positive safe integer. That default is visible, not hidden: every shaped call journals `[workflow:return] <label>: contract v2, N same-session clarification turn(s)` and says whether N is the package default or the author's declaration. Optional `clarification` is nonblank text of any length. Both option objects are closed. `validate` and transport `attempts` combine with shaped output normally; choice fallback exists only for `choice`.

The workflow child alone receives `workflow_return({ value })`. The closure, not tool arguments, owns this call's contract and identity. The tool accepts no file path, call ID or routing target. The first valid proposal is fixed; identical duplicates are idempotent, contradictory second proposals fail the call.

## Same-session lifecycle

The host creates one child session, performs the task and validates the tool proposal. Invalid tool calls receive feedback in that session. If the turn ends without a usable proposal, the host sends bounded clarification to the same session, reusing its history. No fresh worker or second logical workflow call is created for format repair.

After submission, and before a clarification prompt, the host narrows active tools to the return tool and verifies readback. Changes apply to the next model turn: this is not a sandbox, does not roll back a dispatched tool batch, and does not provide exactly-once external effects. Unsupported tool-set readback/restriction fails before the first prompt with `output-contract-unavailable`; there is no silent fresh-session fallback.

Tools, assistant turns and the wall-clock deadline accumulate across clarification. The original outer workflow timeout remains armed. A candidate is committed only when the child finishes successfully; a provider error, cancellation, timeout or budget failure after a proposal still fails. The session is disposed once.

Assistant turns are SDK model cycles (`turn_start`), including normal tool use
before the first proposal. The same cumulative `maxTurns` limit applies to plain
text and tool-return children; `repair.maxAttempts` separately limits output
submissions. A long review can exhaust turns without ever calling
`workflow_return`. Inspect its transcript before diagnosing a format-repair loop.

Format repair is not semantic retry: a record with the right shape is not evidence that its facts are right. A required verifier stays required, and content review is a separate agent call with the original goal and exact feedback, never a hidden continuation of shape clarification.

When an array or object container has the wrong type, correction feedback shows
the raw `value` container syntax.
The agent must fill that container with its existing schema-matching content;
the host never parses a JSON string into an accepted array or object. Correction
examples do not change the initial prompt or the completed-call replay key.

There is no fresh-session shape repair left to fall back to: `choice`, `handoffs`, `output`, `schema` and `schema + validate` all correct the format inside the child that produced the value. Ordinary text calls are unchanged. A semantic `continue` still requires a new worker call and a new conversation.

## Canonical value and evidence

The SDK emits canonical JSON for the accepted value (scalar, object or array); runtime checks that boundary and returns the exact value to workflow code. Identical duplicates are identical canonical JSON; a second proposal with different bytes is a conflict. The ordinary run-owned artifact store records those canonical answer bytes, independently of the model's final narrative. Source does not need filesystem access to persist an accepted value.

`agent_end.outputAcceptance` contains `{ source: "tool", toolName: "workflow_return", attempts }` only on success. `callId`, child session evidence and group `itemPath` bind it to the execution. Missing fresh-execution acceptance receipts fail closed. Replayed calls use recorded validated canonical answers and existing replay provenance; they do not invent a new session receipt.

Choice decisions emit a runtime journal log with `message: "[workflow:choice]"` and `choiceDecision`: `value`, `source: "validated" | "fallback"`, `returnVia` (always `"tool"` on a fresh run; `"text"` appears only in journals written before the text transport was deleted), optional attempts and fallback reason. The transcript shows the source, transport and attempts. Fallback is not ordinary model judgment.

An explicitly declared `choiceFallback` in tool mode applies only to `output-contract-exhausted`. It never turns provider, authorization, cancellation or infrastructure errors into `not-a-dag` or another domain decision. With asymmetric false-negative costs, select an explicit uncertainty value or fail closed. A valid negative classification may still require semantic re-review; output acceptance proves shape, not truth.

## Deliberate limits

This is a shape acceptance boundary, not a new domain-record database. The source archive does not contain the review's private Airflow catalog workflow/composer, so this change does not claim to migrate that workflow. A catalog needs owner-defined `candidateKey → dagRef → fieldKey`, a complete expected-key set and separate states for unknown, absent, failed and skipped. Do not correlate multiple DAGs by comma-separated position. Use accepted values/evidence as the input to that separately owned integration; an agent-written file is not authoritative merely because its returned value was valid.

A conflicting second accepted proposal has `output-contract-conflict`, not exhaustion; it never selects choiceFallback. An explicit `repair` object must supply `maxAttempts`.

## Command completed, answer rejected

Observed failure: a catalog composer wrote its output, then returned
`{"type":"string","enum":["success","failed"]}`. This lists choices but selects
none. The runtime must reject it; accepting the first enum member would invent
success. A file left on disk does not resolve the missing decision.

For agents that execute commands or write files, use the existing tool return:

```js
const result = await agent(
  'Run the command once. Call workflow_return({value:"success"}) only after exit 0; otherwise submit {value:"failed"}. Correct the answer format using the same command evidence, without repeating the command.',
  {
    label: "compose",
    title: "Compose output files",
    choice: ["success", "failed"],
    repair: { maxAttempts: 2 },
  },
);
if (result === "failed") throw new Error("Composition failed or was not confirmed; output files may exist.");
```

The success condition and `label` are authored for the actual stage. The portable
rule is same-session format correction with no fabricated fallback. Validate the
example's actual emitted options, a schema-only echo followed by a corrected value,
and repeated invalid values. Mock graph and syntax checks alone cannot prove model
compliance. A simple narrative lookup still uses plain `agent(prompt, { label, title })`;
do not add tools or extra verification agents to it.

**Replay across this deletion.** The return contract carries a version, and this
release is v2. A record written under v1 no longer matches the key its call now
computes, so the replay reports `return-contract-changed`, names the release
boundary in the journal, and runs that call fresh. Prefix reuse ends at the first
shaped call in an old run — the calls before it still replay byte for byte, and a
plain-text call is unversioned and unaffected. No historical record is rewritten,
and no historically failed call becomes an accepted one.
