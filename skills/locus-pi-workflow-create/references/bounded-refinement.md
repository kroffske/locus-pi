# Reviewer-gated bounded refinement

Use this card when a worker may leave concrete work unfinished. Avoid it without acceptance criteria, when effects cannot be safely repeated, or when only an operator has authority. Do not use worker self-approval for a higher-risk adaptive result.

Graph: fresh worker → independent reviewer → shaped decision; continue → fresh worker with exact handoff. Complete → primary output; failed, cap or no-progress → honest non-success; needs_operator → stop and return.

Cost: the text-review recipe uses 3R logical calls and sequential depth 3R. With `returnVia: "tool"`, output clarification remains in that call's session and still costs tokens/turns/tools. Legacy text `choice` can use one extra physical child per decision. No transport retries are declared in the example.

Handoff: immutable original goal, constraints and criteria; previous worker result; exact reviewer feedback; completed work with evidence; precise remaining scope. Keep only useful prior-round state, not a concatenated transcript. A fresh worker has a new conversation, not a promise of an empty resource environment.

Completion authority: prefer deterministic validation where a real machine criterion exists; use a domain reviewer for semantic criteria; require the operator for permissions and unresolved policy. A model saying “tests passed” and JSON Schema validation are not deterministic proof.

The example chooses three rounds and stops on two consecutive continue_stalled decisions. These are recipe choices, not new global defaults. Progress means changed verified criteria/evidence, not changed prose or tool usage. Stable unresolved criterion IDs help the reviewer compare rounds. No JavaScript regex grades model prose.

Failure: complete publishes the reviewed primary result. At cap/no-progress return `ok:false`, `status:"blocked"` and evidence; never publish the last unreviewed edit as success. A child error propagates; no reviewer-approved fallback can invent missing execution. `needs_operator` declares awaiting_operator and immediately returns. The example's reason-only stop is not an automatic resumable human handoff.

Primitives: agent, choice, literal bounded for, publishArtifact, publishPrimaryArtifact, log, awaitOperator. Whole-value carry is allowed only by the canonical bounded-loop provenance rules in [AUTHORING.md](../../../extensions/workflows/AUTHORING.md). Raw schema/validate remain advanced compatibility.

[Runnable refinement example](../../../extensions/workflows/references/examples/refinement.workflow.mjs). Every round artifact records the original goal, work, review, decision and next-worker feedback. Choose an explicit shared budget at launch; see [execution controls](../../../extensions/workflows/references/execution-controls.md). Replay is separate: see [recovery](../../../extensions/workflows/references/recovery-and-continuation.md).
