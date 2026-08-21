# Sequential text graph

Use when several coherent subtasks operate on one subject and each consumes the
previous answer. Avoid splitting a stage that only reformats its neighbour.

Graph: `inspect -> compose -> review -> publish` (omit unneeded nodes).

Cost: one call per node; sequential depth equals call count.

Handoffs: exact text. The composer returns the complete document; the reviewer
returns a complete corrected replacement. JavaScript does not parse or render.

Failure: any child failure stops the workflow. No local retry or partial envelope.

Primitives: `agent`, `phase`, `publishPrimaryArtifact`; optional `choice` only if
the reviewed design has a real branch.

```js
const evidence = await agent(`Inspect this scope:\n${input}`, { ...AGENTS.reader, label: "inspect" });
const draft = await agent(`Write the complete report:\n${evidence}`, { ...AGENTS.writer, label: "compose" });
const finalText = await agent(`Return the complete corrected report:\n${draft}`, {
  ...AGENTS.reviewer,
  label: "review",
});
return publishPrimaryArtifact("report.md", finalText);
```
