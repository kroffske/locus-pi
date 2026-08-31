# Human gate

Use when policy, ambiguity, or irreversible impact requires a person rather than
a model to decide. Avoid replacing an ordinary model-verifiable branch with a
human pause.

Graph: `prepare -> publish handoff -> awaitOperator -> continue`. Runtime replay
restores the earlier agent result; workflow source does not read an artifact.

Cost: calls before and after the gate plus one operator pause; at least two runs.

Handoffs: publish complete text for the operator. After continuation, pass the
already bound text or later agent answers directly; do not load a file.

Failure: missing operator input remains `awaiting_operator`; invalid continuation
fails before trusted workflow code starts.

Primitives: `publishArtifact`, `awaitOperator`, plus ordinary `agent` calls.

```js
const handoff = publishArtifact("decision.md", decisionText);
awaitOperator({ reason: "Choose the approved direction", artifactRefs: [handoff] });
return handoff;
```
