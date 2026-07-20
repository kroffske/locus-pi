# Workflow pattern catalog

These are authoring skeletons, not additional Package workflows. Save a reviewed
copy under `.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/`, or
`~/.pi/workflows/` before running it. Workflow JavaScript executes with full
Node.js host access and is not sandboxed.

The only curated Package workflows are `live-smoke`, `llm-smoke`,
`requirements-grill`, `review`, and `review-fix`.

## Choose a shape

| Requirement                            | Minimal shape                         |
| -------------------------------------- | ------------------------------------- |
| One bounded tool-using task            | one `agent()`                         |
| Cheap classification or draft          | one `llm()`                           |
| Cheap gate before tool work            | `llm()` then conditional `agent()`    |
| Multi-step work on one subject         | staged text pipeline (see below)      |
| Repeat until an evidenced verdict      | bounded loop plus judge               |
| Plan, implement, and verify            | planner, writer stages, reviewer loop |
| Ordered transformation per item        | `pipeline()`                          |
| Independent work followed by synthesis | `parallel()` then merge               |
| Independent acceptance votes           | `parallel()` judge panel              |

Prefer the staged text pipeline for any requirement that reads "understand X,
then decide about X, then act on X". Reach for a loop, `parallel()`,
`pipeline()`, or a judge panel only when the requirement names work that is
genuinely repeated, independent, or per-item.

When both this row and a group row seem to apply — two independent inventories
that then get compared — stay sequential unless the branches are expensive
enough that the barrier pays for itself. One session that gathers both sides
keeps their vocabulary consistent; two sessions plus a merge stage cost three
calls to save one.

## Staged text pipeline (the review-family shape)

This is the default shape for multi-step work on a single subject, and the one
the curated `review` and `review-fix` workflows use. Every stage is one
`agent()` with one coherent cognitive job; each handoff is the previous stage's
exact text; the workflow never parses that text.

```js
// `maxToolCalls: 1_000` restates the runtime default so the runaway fuse is
// visible in the source. Drop it, or lower it, when a stage should be cheaper.
const STAGE_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
  permissionMode: "agent-defined",
  workspaceMode: "project",
});
const READ_OPTIONS = Object.freeze({
  ...STAGE_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "grep", "find"],
});
const PUBLISH_OPTIONS = Object.freeze({
  ...STAGE_DEFAULTS,
  tools: ["read", "write", "bash", "grep", "find"],
});

phase("resolve-scope");
const scopeText = await agent(await promptFile("./resources/scope-resolver.prompt.md", { ORIGINAL_REQUEST: input }), {
  ...READ_OPTIONS,
  label: "resolve scope",
});

phase("plan-units");
const unitsText = await agent(await promptFile("./resources/unit-planner.prompt.md", { SCOPE_TEXT: scopeText }), {
  ...READ_OPTIONS,
  label: "plan units",
});

phase("verify");
const reportText = await agent(
  await promptFile("./resources/verifier.prompt.md", { SCOPE_TEXT: scopeText, UNITS_TEXT: unitsText }),
  { ...READ_OPTIONS, label: "verify and write report" },
);

phase("publish");
return agent(await promptFile("./resources/publisher.prompt.md", { UNITS_TEXT: unitsText, REPORT_TEXT: reportText }), {
  ...PUBLISH_OPTIONS,
  label: "publish package",
});
```

Stage roles, in the order they usually appear:

| Stage       | Owns                                                            | Keep it out of                       |
| ----------- | --------------------------------------------------------------- | ------------------------------------ |
| Resolver    | Free-form operator intent -> one explicit, self-contained scope | Doing the work itself                |
| Inventory   | Proving complete coverage of the subject                        | Grouping or judging                  |
| Planner     | Grouping the inventory into atomic units of meaning             | Findings, verdicts, fixes            |
| Interrogate | Falsifiable questions about each unit                           | Answering its own questions          |
| Implementer | Applying the planned units to source                            | Deciding what to apply               |
| Verifier    | Reopening evidence, answering, and authoring the report         | Formatting and persistence decisions |
| Publisher   | Writing the artifacts and returning an executive summary        | Inventing or deleting substance      |

**Do not ship all seven.** The table is a menu, not a sequence. Two stages is a
complete pipeline: one that produces the substance, one that persists it. Add a
third only when it answers a question the others cannot, and be able to name
that question. `review` needs six because a review is genuinely
coverage-then-grouping-then-questions-then-answers; a workflow that greps two
files and reports needs two. `review-fix` has no inventory or interrogator stage
at all.

Ask of every extra stage: what does it decide that its neighbour cannot? If the
honest answer is "it reformats" or "it restates", delete it.

Rules that make the shape work:

- Inspection stages pass `readOnly: true`, which the host enforces by removing
  shell, write/edit, nested workflow, and unknown tools. Put every read-only
  stage before the first stage that writes anything.
- Separate the two kinds of writing. A stage that mutates source (`review-fix`'s
  implementer, mid-pipeline) and a stage that persists artifacts (the publisher,
  last) are different privileges and different prompts; do not merge them, and
  do not give either one to an inspection stage.
- The publisher is a privilege hop, not a reasoning step. It exists because the
  stage that produced the substance could not write. When a workflow's output is
  useful as the run result alone — `result.json` is durable — you may not need a
  publisher at all.
- Only give a stage `bash` when it must run something: repository checks, or
  proving an output directory is ignored before writing there. A publisher that
  writes into an already-known path does not need a shell.
- Pass forward only the artifacts the next stage needs, never the operator
  conversation, runtime logs, or another stage's scratch reasoning. With a
  resolver, downstream stages read the normalized scope instead of the raw
  request. Without one, only the first stage sees `input`, and its output
  contract must carry forward whatever the later stages need.
- Human-readable ids (`U1`, `U1-Q1`, `F1`, `X1`) exist so a reader can follow a
  unit through the artifacts. Nothing parses them.
- Deterministic workflow code belongs at the edges, and only for what a prompt
  cannot do: confining an operator-supplied path, or refusing to start when
  there is nothing to act on. `review-fix-input.mjs` is the whole of it.
- Decide where artifacts land, and say it in the publisher prompt. The review
  family writes into one local task's `artifacts/` directory and proves
  `.tasks/` is git-ignored first; that is a repository convention, not a runtime
  rule. A workflow with a different natural home says so explicitly instead of
  copying `.tasks/` blindly.
- Add loops, retries, hashes, resumability, or fan-out only after a reproduced
  failure in the simpler shape, or a hard safety boundary where failure would
  mutate source, spend money, or be externally visible.

Runnable examples to adapt: `extensions/workflows/examples/review/` and
`extensions/workflows/examples/review-fix/`, with the reader algorithm in
`examples/review/README.md`.

## Single agent

```js
export const meta = { name: "one-agent", description: "Run one bounded tool-using task." };

export default async function run({ agent, phase }, input) {
  phase("work");
  const text = await agent(input, {
    agent: "quick_task",
    label: "work",
    permissionMode: "agent-defined",
  });
  return text;
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
return work;
```

## Bounded loop plus judge

```js
const maxRounds = 3;
for (let round = 1; round <= maxRounds; round += 1) {
  const work = await agent(`Round ${round}: ${input}`, { label: `work:${round}` });

  const judge = await llm(`Is this complete? Reply with done boolean.\n${work}`, {
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

const build = await agent(`Implement this plan:\n${plan}`, {
  agent: "task",
  label: "build",
  workspaceMode: "worktree",
});

const review = await agent(`Review the implementation:\n${build}`, {
  agent: "reviewer",
  label: "review",
});
return review;
```

## Ordered pipeline

```js
const outputs = await pipeline(
  items,
  async ({ item }) => ({ item, extracted: await agent(`Inspect ${item}`) }),
  async (state) => ({ ...state, classified: await llm(`Classify ${state.extracted}`) }),
);
return { ok: true, outputs };
```

`pipeline()` is fail-closed: an uncaught stage failure rejects the group. Catch
only `WORKFLOW_GROUP_FAILURE` when requirements explicitly accept partial work,
and return `partial: true`; partial is never projected as success.

## Parallel fan-out and merge

```js
const findings = await parallel(
  targets.map((target) => () => agent(`Inspect ${target}`, { agent: "explore", label: `inspect:${target}` })),
);
const merge = await agent(findings.map((item, index) => `${index + 1}. ${item}`).join("\n"), {
  agent: "librarian",
  label: "merge",
});
return merge;
```

## Judge panel

```js
const votes = await parallel(
  ["strict", "balanced", "skeptical"].map(
    (perspective) => () => llm(`${perspective} judge: ${input}`, { schema: VERDICT_SCHEMA }),
  ),
);
const passed = votes.filter((vote) => vote.ok && vote.output.verdict === "pass").length;
return { ok: passed > votes.length / 2, passed, total: votes.length };
```

Choose majority or unanimity explicitly. If any panel slot fails and partial
panels are not accepted by requirements, let the group fail closed.

## Loop until dry

```js
let emptyStreak = 0;
for (let round = 1; round <= 5; round += 1) {
  const sweep = await agent(`Find remaining work, round ${round}`, { label: `sweep:${round}` });
  const measured = await llm(`Count evidenced remaining items in this report:\n${sweep}`, {
    schema: {
      type: "object",
      required: ["remaining"],
      properties: { remaining: { type: "number" } },
    },
  });
  if (!measured.ok) return { ok: false, error: "Remaining-work measurement failed" };
  const remaining = measured.output.remaining;
  emptyStreak = remaining === 0 ? emptyStreak + 1 : 0;
  if (emptyStreak >= 2) return { ok: true, stoppedBy: "dry", round };
}
return { ok: false, stoppedBy: "round-cap", error: "Dry state was not proven" };
```

Always separate the measured exit condition from the safety cap and record
which condition stopped the run.
