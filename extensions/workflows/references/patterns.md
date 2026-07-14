# Workflow pattern catalog

These are authoring skeletons, not additional Package workflows. Save a reviewed
copy under `.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/`, or
`~/.pi/workflows/` before running it. Workflow JavaScript executes with full
Node.js host access and is not sandboxed.

The only curated Package workflows are `live-smoke`, `llm-smoke`, and
`requirements-grill`.

## Choose a shape

| Requirement | Minimal shape |
|---|---|
| One bounded tool-using task | one `agent()` |
| Cheap classification or draft | one `llm()` |
| Cheap gate before tool work | `llm()` then conditional `agent()` |
| Repeat until an evidenced verdict | bounded loop plus judge |
| Plan, implement, and verify | planner, writer stages, reviewer loop |
| Ordered transformation per item | `pipeline()` |
| Independent work followed by synthesis | `parallel()` then merge |
| Independent acceptance votes | `parallel()` judge panel |

## Single agent

```js
export const meta = { name: "one-agent", description: "Run one bounded tool-using task." };

export default async function run({ agent, phase }, input) {
  phase("work");
  const result = await agent(input, {
    agent: "quick_task",
    label: "work",
    permissionMode: "agent-defined",
  });
  return { ok: Boolean(result?.ok), summary: result?.summary ?? null };
}
```

## Cheap gate before tool work

```js
const gate = await llm(`Classify whether tool work is needed: ${input}`, {
  schema: {
    type: "object",
    required: ["needsTools"],
    properties: { needsTools: { type: "boolean" } },
  },
});

if (!gate?.ok) return { ok: false, error: gate?.error ?? "Gate failed" };
if (!gate.output.needsTools) return { ok: true, skipped: true };

const work = await agent(input, { agent: "quick_task", label: "work" });
return { ok: Boolean(work?.ok), summary: work?.summary ?? null };
```

## Bounded loop plus judge

```js
const maxRounds = 3;
for (let round = 1; round <= maxRounds; round += 1) {
  const work = await agent(`Round ${round}: ${input}`, { label: `work:${round}` });
  if (!work?.ok) return { ok: false, error: work?.error ?? "Work failed" };

  const judge = await llm(`Is this complete? Reply with done boolean.\n${work.summary}`, {
    schema: {
      type: "object",
      required: ["done"],
      properties: { done: { type: "boolean" } },
    },
  });
  if (judge?.ok && judge.output.done) return { ok: true, stoppedBy: "judge", round };
}
return { ok: false, stoppedBy: "round-cap", error: "Completion was not proven" };
```

## Plan, build, review

```js
const plan = await agent(`Plan: ${input}`, { agent: "plan", label: "plan" });
if (!plan?.ok) return { ok: false, error: "Planning failed" };

const build = await agent(`Implement this plan:\n${plan.summary}`, {
  agent: "task",
  label: "build",
  workspaceMode: "worktree",
});
if (!build?.ok) return { ok: false, error: "Build failed" };

const review = await agent(`Review the implementation:\n${build.summary}`, {
  agent: "reviewer",
  label: "review",
});
return { ok: Boolean(review?.ok), plan: plan.summary, review: review?.summary ?? null };
```

## Ordered pipeline

```js
const outputs = await pipeline(items,
  async ({ item }) => ({ item, extracted: await agent(`Inspect ${item}`) }),
  async (state) => ({ ...state, classified: await llm(`Classify ${state.extracted.summary}`) }),
);
return { ok: true, outputs };
```

`pipeline()` is fail-closed: an uncaught stage failure rejects the group. Catch
only `WORKFLOW_GROUP_FAILURE` when requirements explicitly accept partial work,
and return `partial: true`; partial is never projected as success.

## Parallel fan-out and merge

```js
const findings = await parallel(targets.map((target) => () =>
  agent(`Inspect ${target}`, { agent: "explore", label: `inspect:${target}` })
));
const merge = await agent(
  findings.map((item, index) => `${index + 1}. ${item.summary}`).join("\n"),
  { agent: "librarian", label: "merge" },
);
return { ok: Boolean(merge?.ok), summary: merge?.summary ?? null };
```

## Judge panel

```js
const votes = await parallel(["reviewer", "oracle", "explore"].map((role) => () =>
  agent(input, { agent: role, label: `vote:${role}`, schema: VERDICT_SCHEMA })
));
const passed = votes.filter((vote) => vote?.ok && vote.output?.verdict === "pass").length;
return { ok: passed > votes.length / 2, passed, total: votes.length };
```

Choose majority or unanimity explicitly. If any panel slot fails and partial
panels are not accepted by requirements, let the group fail closed.

## Loop until dry

```js
let emptyStreak = 0;
for (let round = 1; round <= 5; round += 1) {
  const sweep = await agent(`Find remaining work, round ${round}`, { label: `sweep:${round}` });
  const remaining = Number(sweep?.output?.remaining ?? 0);
  emptyStreak = remaining === 0 ? emptyStreak + 1 : 0;
  if (emptyStreak >= 2) return { ok: true, stoppedBy: "dry", round };
}
return { ok: false, stoppedBy: "round-cap", error: "Dry state was not proven" };
```

Always separate the measured exit condition from the safety cap and record
which condition stopped the run.
