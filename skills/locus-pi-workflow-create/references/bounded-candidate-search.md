# Bounded candidate search

Use when preserving competing solutions is itself valuable and a benchmark or
hard requirement justifies the call cost. Avoid it for ordinary synthesis.

Graph: `frame -> 3 proposers -> 3 evaluators -> shortlist choice -> 2 revisions
-> final choice -> verifier -> publish`.

Cost: about 12 calls at depth seven for the 3→2→1 form.

Handoffs: every candidate, evaluation, revision, and verification is complete
text. Small selection calls use exact `choice` over visible candidate names.

Failure: any parallel barrier, insufficient viable candidates, verifier rejection,
or cap exhaustion fails closed without terminal publication.

Primitives: `agent`, `parallel`, `choice`, visible fixed arrays, and
`publishPrimaryArtifact`.

```js
const candidates = await parallel(PROPOSERS.map((options) => () => agent(FRAME, options)));
const selected = await agent(`Choose one candidate name:\n${namedCandidates}`, {
  ...AGENTS.router,
  choice: ["candidate-a", "candidate-b", "candidate-c"],
});
```

Do not copy research schemas or JavaScript ranking/rendering code. The agents
write and evaluate the candidate texts; the script only preserves visible routing.
