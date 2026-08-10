# Bounded review loop

Use when a produced document may need critique and revision before acceptance.
Avoid it when a single fresh reviewer can return the final corrected replacement.

Graph: `draft -> critique -> route`; `revise -> draft` before the next review, up to `R - 1` revisions across `R` review decisions;
`accept -> publish`; cap exhaustion -> fail.

Cost: minimum 3 calls (draft, critique, route). With `R` review decisions, maximum
is `1 + 2R + (R - 1) = 3R` calls. The critique is text; a separate `choice` call
selects `accept` or `revise`; every paid revision is reviewed in a later round.

Handoffs: critique remains exact reader-facing text. Revision returns the complete
replacement document, never a patch or JSON envelope.

Failure: child failure and round-cap exhaustion fail closed. No custom recovery.

Primitives: `agent`, `choice`, a visible bounded `for` loop, `publishPrimaryArtifact`.

```js
let document = await agent(DRAFT_PROMPT, AGENTS.writer);
const MAX_REVIEWS = 2;
for (let round = 1; round <= MAX_REVIEWS; round += 1) {
  const critique = await agent(`Review this document:\n${document}`, AGENTS.reviewer);
  const route = await agent(`Choose using this critique:\n${critique}`, {
    ...AGENTS.router,
    choice: ["accept", "revise"],
  });
  if (route === "accept") return publishPrimaryArtifact("result.md", document);
  if (round === MAX_REVIEWS) break;
  document = await agent(`Return a complete revision:\n${document}\n\n${critique}`, AGENTS.writer);
}
throw new Error("review round limit reached without acceptance");
```
