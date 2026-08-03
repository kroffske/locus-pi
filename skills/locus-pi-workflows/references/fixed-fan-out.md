# Fixed fan-out/fan-in

Use when the approved design names independent, author-known questions or units
that benefit from concurrency, followed by one synthesis. Avoid it when branches
need each other, when semantic input would need splitting/parsing to recover the
units, or when runtime must discover an unknown unit list.

Graph: `input -> [worker-a || worker-b || ...] -> composer -> optional reviewer`.

Cost: `N + 1` calls, or `N + 2` with review; depth two or three.

Handoffs: each worker returns a complete textual finding/list. Composer receives
all texts unchanged and returns the complete document.

Failure: `parallel()` is one fail-closed barrier. Do not catch it into partial
success in standard source.

Input boundary: put fixed unit names/paths directly in the approved design and
source. Do not encode them as newline/CSV/JSON workflow input and parse them in
JavaScript. If units are not author-known, this pattern does not fit.

Primitives: `agent`, `parallel`, `phase`, `publishPrimaryArtifact`.

```js
const findings = await parallel([
  () => agent(PROMPT_A, { ...AGENTS.reader, label: "question-a" }),
  () => agent(PROMPT_B, { ...AGENTS.reader, label: "question-b" }),
]);
const document = await agent(`Compose the complete report:\n${findings.join("\n\n")}`, AGENTS.composer);
return publishPrimaryArtifact("report.md", document);
```
