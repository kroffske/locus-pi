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

Input boundary: fixed unit names/paths may live directly in approved source.
When the main agent already knows them, pass exact `items: string[]` through the
workflow tool and read `dsl.items()`; when a discovery agent must find them, use
bounded `agent({ handoffs })`. All three sources converge on the same visible
`pipeline(items, ...)` or `parallel()` body. Do not encode them as newline/CSV/JSON
input and parse them in JavaScript. Caller items
preserve empty strings and duplicates; model handoffs separately reject them.

Primitives: `agent`, `parallel`, `phase`, `publishPrimaryArtifact`.

```js
const findings = await parallel([
  () => agent(PROMPT_A, { ...AGENTS.reader, label: "question-a" }),
  () => agent(PROMPT_B, { ...AGENTS.reader, label: "question-b" }),
]);
const document = await agent(`Compose the complete report:\n${findings.join("\n\n")}`, AGENTS.composer);
return publishPrimaryArtifact("report.md", document);
```
