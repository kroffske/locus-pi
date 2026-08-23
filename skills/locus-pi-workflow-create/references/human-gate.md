# Human gate

Use when policy, ambiguity, or irreversible impact requires a person rather than
a model to decide. Avoid replacing an ordinary model-verifiable branch with a
human pause.

Graph: `prepare -> publish handoff -> awaitOperator`; a later continuation run
consumes the host-verified artifact and continues.

Cost: calls before and after the gate plus one operator pause; at least two runs.

Handoffs: publish complete text. Continuation uses runtime-owned artifact refs,
not paths or JSON embedded in semantic input.

Failure: missing operator input remains `awaiting_operator`; invalid continuation
fails before trusted workflow code starts.

Primitives: `publishArtifact`, `awaitOperator`, `continuationArtifacts`,
`consumeTextArtifact`, plus ordinary `agent` calls.

```js
const handoff = publishArtifact("decision.md", decisionText);
awaitOperator({ reason: "Choose the approved direction", artifactRefs: [handoff] });
return handoff;
```
