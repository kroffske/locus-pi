# Workflow pattern catalog

These are authoring skeletons, not additional Package workflows. Save a reviewed
copy under `.pi/workflows/`, `.claude/workflows/`, `.agents/workflows/`, or
`~/.pi/workflows/` before running it. Workflow JavaScript executes with full
Node.js host access and is not sandboxed.

The Package workflows are whatever `extensions/workflows/examples/` holds —
currently `live-smoke`, `plan`, `plan-implement`, `requirements-grill`, `review`,
and `review-fix`. A skeleton copied out of this catalog becomes one by being
saved there, with the package-surface review that implies; saved anywhere else it
stays yours.

## Choose a shape

| Requirement                             | Minimal shape                               |
| --------------------------------------- | ------------------------------------------- |
| One bounded tool-using task             | one `agent()`                               |
| Cheap classification or draft           | one no-tool `agent({ schema })`             |
| Cheap gate before tool work             | shaped `agent()` then conditional `agent()` |
| Yes/no answer the script must branch on | `agent({ schema })` with an `enum`          |
| A few fixed fields for the next stage   | `agent({ schema })`, closed object          |
| Multi-step work on one subject          | staged text pipeline (see below)            |
| Repeat until an evidenced verdict       | bounded loop plus judge                     |
| Plan, implement, and verify             | planner, writer stages, reviewer loop       |
| Ordered transformation per item         | `pipeline()`                                |
| Independent work followed by synthesis  | `parallel()` then merge                     |
| Independent acceptance votes            | `parallel()` judge panel                    |

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

Write the prompts inline, in the script, next to the call they belong to. One
file is the whole workflow: the contract every stage shares, the per-stage task,
the capability options, and the routing between them are read in one pass, and
the retained script snapshot covers the prompt bytes too.

```js
// The contract every stage shares. One constant, prepended to each stage prompt,
// so a rule changes in one place and no stage can quietly disagree with another.
const COMMON = `Work only inside the current repository.

Read first: AGENTS.md, then the entry point named in the task below.

Hard rules:
- Do not commit, push, stage, or switch branches.
- Every factual claim carries a repo-resolvable \`path:line\` citation.
- A claim you could not verify is a finding to report, not a detail to hide.

Your final text is the handoff the next stage receives, not a message to a human.`;

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
const scopeText = await agent(
  `${COMMON}

TASK — turn the operator's request into one explicit, self-contained scope.
Do not start the work itself; a later stage does that.

--- BEGIN OPERATOR REQUEST ---
${input}
--- END OPERATOR REQUEST ---

Return Markdown with \`## In scope\`, \`## Out of scope\`, and \`## Unknowns\`.
Write \`- none\` under a heading that has nothing to list.`,
  { ...READ_OPTIONS, label: "resolve scope" },
);

phase("plan-units");
const unitsText = await agent(
  `${COMMON}

TASK — group the scope into atomic units of meaning. Do not judge them and do
not propose fixes.

--- BEGIN SCOPE ---
${scopeText}
--- END SCOPE ---

Return one \`## U<n>\` section per unit, each naming the files it covers.
Return \`## No units\` with a one-line reason when the scope is empty.`,
  { ...READ_OPTIONS, label: "plan units" },
);

phase("verify");
const reportText = await agent(
  `${COMMON}

TASK — reopen the evidence yourself and write the report. The units are a work
map, not evidence: read the source before you assert anything about it.

--- BEGIN SCOPE ---
${scopeText}
--- END SCOPE ---

--- BEGIN UNITS ---
${unitsText}
--- END UNITS ---

Return the reader-facing report: \`## Verdict\`, \`## Findings\` (\`None.\` when
there are none), \`## Coverage and limits\`.`,
  { ...READ_OPTIONS, label: "verify and write report" },
);

phase("publish");
return agent(
  `${COMMON}

TASK — write the report to its artifact path and return a short executive
summary. Do not invent, re-judge, or delete substance.

--- BEGIN REPORT ---
${reportText}
--- END REPORT ---`,
  { ...PUBLISH_OPTIONS, label: "publish package" },
);
```

Reach for a neighboring `./resources/<stage>.prompt.md` through `promptFile()`
in the two cases where a file earns its indirection: a role charter long enough
that inlining it buries the routing (roughly 80 lines and up — the curated
`review` verifier is one), or a prompt genuinely shared by more than one
workflow. Everything else — including every stage of a two- or three-stage
pipeline — belongs in the script. A `promptFile` reference must resolve to a
packaged `*.prompt.md`; a boundary test enforces that, so the escape hatch stays
a real file rather than a guess.

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
`examples/review/README.md`. For the same shape with loops inside it — an
operator clarification round that pauses the run, and a draft/critique loop that
exits on a shaped verdict — read the tracked pair
`extensions/workflows/examples/plan/` and `examples/plan-implement/`.

## Writing one stage task

A stage is one `agent()` call plus the prompt written next to it. Writing it is
four decisions and nothing else:

1. **The one question it answers.** Name it in a sentence. If the sentence needs
   an "and", it is two stages — or the second half only restates the first, and
   then it is one.
2. **Its capability.** `readOnly: true` with read tools for inspection, `bash`
   only for a stage that must run something, `write`/`edit` only for the stage
   that must change something. The `agent()` options are the boundary; the prompt
   paragraph only explains it.
3. **What it receives.** The shared `COMMON` contract, then the previous stage's
   exact text interpolated between `--- BEGIN <NAME> ---` / `--- END <NAME> ---`
   markers, plus the original operator intent when later stages must not lose the
   focus. Nothing else: not the operator conversation, not runtime logs, not a
   sibling's scratch reasoning.
4. **What it leaves behind.** `label` is the human-readable verb phrase in the
   live panel and the journal; `artifact: "<name>.md"` names the answer in the run
   store. The runtime persists it — no publisher child is needed to save text.

The stage's _task_ lives in its prompt, not in control flow: the question, the
explicit list of what this stage must NOT do, and an output template with a
stated rule for the empty case (`None.`, `- none`, an explicit `## No changes`
declaration). A stage that has no way to say "nothing here" will invent
something. Write that prompt inline in the script — the default above — and move
it to a `*.prompt.md` only for a long role charter or a prompt two workflows
share.

### What the script may check

The script orchestrates and bounds; it does not grade the answer. The whole
allowed set, and every item is about being able to continue at all:

- non-empty text and a per-stage character cap — an empty or oversized handoff
  breaks the next prompt before the model ever sees it;
- confining an operator-supplied path, or refusing to start when there is nothing
  to act on;
- host-owned trust: continuation refs, lineage, digests, identity;
- one declaration the script must branch on — and then through
  `agent({ schema })`, where the runtime re-asks the child with the previous
  attempt's validator errors before failing closed. That retry is the only
  correction loop the DSL gives you for free.

**Three tiers, in this order.** Reach for the cheapest one that can express the
rule; drop a tier only when the one above genuinely cannot say it.

1. **A schema keyword.** Anything about one node: type, count, length, pattern,
   enum, uniqueness, blankness.
2. **`validate`** — the script callback on the same `agent({ schema })` call. Any
   rule over the whole answer: referential integrity against data the host owns,
   agreement between two fields, a budget summed across items, graph shape. It
   returns `string[]`, and the runtime feeds a non-empty return back to the child
   in its own repair block. This is script code that no longer ends the run.
3. **A fatal `throw`** — only for the two classes a retry loop can be talked
   past, plus evidence this child did not produce and cannot repair:
   - **self-reported status** — the check accepts the model's word about
     something the host did not verify. The repair bullet explains _why_ the
     success claim was refused, which coaches the model toward a claim the host
     accepts;
   - **verdict coherence** — a model's verdict graded against its own findings
     list. "A `revise` verdict requires at least one finding" has two satisfying
     moves, fabricate a finding or flip the verdict, and both destroy the signal;
   - **host-owned continuation, lineage, digests and identity**, and text a
     _prior_ run's agent wrote.

   The test for tier 2 versus tier 3 is not "does it touch host evidence" — a
   deterministic membership re-check against a host-parsed map runs identically
   on every attempt and cannot be negotiated with, only complied with. The test
   is whether a bullet handed to the model offers it a second way to satisfy the
   check.

Do not write a validator over model prose: no required headings, no id ledgers,
no cross-stage reconciliation, no "the answer must mention every X". Ids like
`C1`, `U1`, `F1` exist so a reader can follow one unit through the artifacts;
nothing parses them. A `throw` over prose grammar has exactly one outcome — the
run dies having paid for every earlier stage, with no way to hand the prompt back
for a correction.

Reference, so the trade-off is known and not rediscovered: until 2026-07 the
curated `review` entry enforced its own Markdown — unique `## C<n>` ids, a
`Coverage:` ledger per unit, `## Coverage reconciliation` and
`## Coverage and limits` sections with the exact unit assignment preserved. On a
clean worktree the inventory honestly answered "no unstaged tracked changes", the
id gate threw, and a legitimately empty scope surfaced as a failed run after
three model calls. Those gates are gone. The prompts still ask for the ids
because they make a review better, and the verifier reports its own coverage. The
cost of dropping them is real — a stage can now under-cover its subject quietly —
and the way to buy it back is a schema or a bounded re-ask loop, never a fatal
throw.

### Bounds belong in the schema, invariants belong in the script

Every count, length, id pattern, and enum goes in `agent({ schema })`, because
the runtime hands a violation back to the child with the validator's own message
and lets it try again. The same rule written as a `throw` ends the run instead.
What stays in script code is what no declared keyword can say.

`review-fix` is the shipped worked example. Its selector schema
([`review-fix.workflow.mjs`](../examples/review-fix/review-fix.workflow.mjs)):

```js
const FINDING_SELECTOR_SCHEMA = freezeSchema({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SELECTED_FINDINGS,
      uniqueBy: "id",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "note", "dependsOn"],
        properties: {
          id: { type: "string", pattern: FINDING_ID_PATTERN },
          note: { type: "string", maxLength: MAX_NOTE_CHARS },
          dependsOn: {
            type: "array",
            maxItems: MAX_SELECTED_FINDINGS,
            uniqueItems: true,
            items: { type: "string", pattern: FINDING_ID_PATTERN },
          },
        },
      },
    },
  },
});
```

Until 2026-07-26 each of those bounds was a hand-rolled check. Thirteen of them
disappeared into the declared keywords above; seven more (`isRecord`,
`Array.isArray`, `typeof … !== "string"`) were pure restatements of `type:` that
the runtime had already rejected before the validator ever ran.

**Uniqueness is a keyword now, not an invariant.** `uniqueBy: "id"` owns "one
entry per finding" and `uniqueItems` owns "no dependency listed twice"; on a
string array a consumer will trim, `uniqueTrimmedItems` owns it, and `nonBlank`
owns a string that satisfies `minLength: 1` while being pure whitespace. All
four canonicalize with `String.prototype.trim`, the same call a normalizer uses,
so a value the runtime accepted cannot collapse afterwards. Reach for a keyword
before you reach for a `throw`: a repeat the child is told about is usually
repaired on the retry, and a repeat it is not told about ends the run.

What survives is the honest residue — every line of it needs a fact the schema
does not have. It is tier 2, not tier 3: the same rules, now returned as strings
from `findingPlanErrors` and passed as the call's `validate`:

```js
const selection = await agent(prompt, {
  schema: FINDING_SELECTOR_SCHEMA,
  // A per-call-site closure: `findings` was parsed once, before the call.
  validate: (value) => findingPlanErrors(findings, value),
});
const selected = orderFindingPlan(findings, selection);
```

```js
// inside findingPlanErrors — it accumulates and never throws
if (!byId.has(id)) errors.push(`findings[${index}].id: value ${JSON.stringify(id)} is not a finding id in the review`);
// …
if (dependency === id) errors.push(`${at} is the finding's own id`);
else if (!selectedIds.has(dependency)) errors.push(`${at} is not one of the selected findings`);
// …then a fixpoint over the edges, and:
errors.push(`findings: the dependency graph contains a cycle among ${unresolved.join(", ")}`);
```

Referential integrity against the immutable review, self-edges and acyclicity are
still inexpressible as keywords — but that is an argument for tier 2, not for
tier 3. The review text these ids are checked against is embedded verbatim in the
selector's own prompt, so the map is identical on every attempt and the only way
to pass is to name a real id. Splitting the old function in two is what makes it
safe: `findingPlanErrors` decides, `orderFindingPlan` only merges and sorts, and
neither one can quietly do the other's job.

A **cross-field invariant** is the same idea inside one answer. `review`'s
clarifier declares `decision` and `questions` separately, and no schema can say
that one constrains the other
([`review.workflow.mjs`](../examples/review/review.workflow.mjs)):

```js
// inside clarifierDecisionErrors, this call's `validate`
if (decision === "continue") {
  if (questions.length !== 0) {
    errors.push(`questions: expected 0 item(s) when decision is "continue", got ${questions.length}`);
  }
  return errors;
}
// The upper bound is `maxItems`; this lower bound applies only to this branch.
if (questions.length < 1) {
  errors.push('questions: expected at least 1 item(s) when decision is "needs_operator", got 0');
}
```

The same callback keeps `recommended` honest — it must equal one of the options
in its own question — and enforces a budget summed across prompts, which is a sum
no keyword computes. What it no longer does is check uniqueness or blankness:
`uniqueBy: "id"` on `questions`, `uniqueTrimmedItems` on `options`, and
`nonBlank` on both string fields moved those into the schema on 2026-07-26, so
the trimming that remains only canonicalizes. What it no longer does either is
`throw`: `normalizeClarifierDecision` runs afterwards and rejects nothing, so
every one of these rules reaches the child before the call can fail closed.

Write the messages the way the runtime writes its own — 0-indexed JSON path,
observed value, what would satisfy it. `review clarification questions must be
unique` was the old wording for a check that compared `question.id`; a child
re-asked with that string would reword its prompts and reproduce the collision.

Bounds on **free text** are per-call, not per-script: `maxAnswerChars` on the
`agent()` call that produces the answer, so an oversized handoff names the stage
that produced it instead of the stage that tried to forward it. Keep hand-written
bounds only for text the workflow itself owns — operator input, consumed
artifacts, and strings the script composes.

### Declare the fact, do not scan the prose

The named anti-pattern is a regex over model-authored text that decides
something. It fails in both directions: it misses every paraphrase, and it fires
on innocent sentences that happen to contain the word.

```js
// Anti-pattern: the gate is defeated by wording the model never intended to hide.
const needsOperatorProof = /\b(TUI|manual|manually|operator|by hand)\b/iu.test(planText);
```

"Someone will need to eyeball the dashboard" never matches. Replace the scan with
a declared field, and have a _fresh_ reader check the declaration against the
original request:

```js
// The plan declares the fact; a separate reviewer stage checks the declaration.
schema: {
  type: "object",
  additionalProperties: false,
  required: ["externalEvidenceRequired", "rationale"],
  properties: {
    externalEvidenceRequired: { type: "boolean" },
    rationale: { type: "string", minLength: 1, maxLength: 500 },
  },
}
// …later, deterministically:
if (plan.externalEvidenceRequired && receipts.length === 0) {
  throw new Error("plan requires external evidence that no receipt provides");
}
```

Record what this costs, because it is not free: a regex over the request could
not be lied to, and a declared boolean can. The guarantee moves from one brittle
host check to two independent model readings — weaker against a planner and a
reviewer who err the same way, stronger against everything else. Do not make this
trade silently.

The one regex the shipped examples still run over model text is
`declaredNoChanges()` in `review.workflow.mjs`, and its own comment says why it
is allowed: it is a **cheap early exit, not a gate**. When the inventory declares
`## No changes` and lists no `C<n>`, three later stages have nothing to work
with, so the run finishes instead of paying for them. It cannot fail the run, and
nothing downstream depends on it being right.

## Semantic text input

Both `/workflows run <name> [input]` and the `workflow` tool pass one optional
bounded string. It is the operator's semantic request, not a command language or
serialized parameter object. Let an agent interpret meaning; keep only explicit
deterministic invariants in JavaScript:

```js
export default async function run({ agent, phase }, input) {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, summary: "An audit request is required." };
  }

  phase("audit");
  return agent(`Interpret and perform this audit request exactly:\n\n${input}`, {
    agent: "reviewer",
    readOnly: true,
    label: "audit",
  });
}
```

Cross-run identity is not embedded in text. The tool may separately attach the
closed host `continuation` control; the runtime verifies its complete artifact
refs before workflow code starts, and the script reads the bound copies through
`dsl.continuationArtifacts()`.

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
// A no-tool child is the cheap path: nothing to call, and the declared shape is
// enforced by the runtime, so the script branches on a value it did not parse.
const gate = await agent(`Classify whether tool work is needed: ${input}`, {
  label: "gate",
  tools: [],
  maxToolCalls: 0,
  schema: {
    type: "object",
    required: ["needsTools"],
    properties: { needsTools: { type: "boolean" } },
  },
});

if (!gate.needsTools) return { ok: true, skipped: true };

const work = await agent(input, { agent: "quick_task", label: "work" });
return work;
```

## Shaped answer from an agent

Use `agent({ schema })` when the script itself must branch on the answer. The
call runs an ordinary child agent — same catalog agent, same capability options
— but returns the **validated value** instead of text, and throws
`SchemaValidationError` if the child cannot produce that shape within the retry
budget. Nothing unshaped ever reaches the script.

Yes/no answer — an `enum` leaves the child no room to answer "it depends":

```js
const gate = await agent(`Does this diff need a security review?\n${diff}`, {
  agent: "reviewer",
  readOnly: true,
  label: "security-gate",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["needsSecurityReview"],
    properties: { needsSecurityReview: { type: "boolean" } },
  },
});

if (!gate.needsSecurityReview) return { ok: true, skipped: "no security surface" };
```

Small fixed field set — one closed object handed to the next stage:

```js
const triage = await agent(`Triage this failure report:\n${report}`, {
  agent: "reviewer",
  readOnly: true,
  label: "triage",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["severity", "component", "summary"],
    properties: {
      severity: { type: "string", enum: ["low", "medium", "high"] },
      component: { type: "string" },
      summary: { type: "string" },
    },
  },
});

const fix = await agent(`Fix the ${triage.severity} defect in ${triage.component}: ${triage.summary}`, {
  agent: "task",
  label: "fix",
  workspaceMode: "worktree",
});
```

Keep shaped stages small and closed. `enum`, `additionalProperties: false`, and
a short `required` list are what make the answer machine-checkable; a wide schema
with free-form prose fields is where a weak model spends both attempts and the
stage fails closed. Everything narrative stays a plain `agent()` call.

Add `minLength` / `maxLength` / `pattern` on strings and `minItems` / `maxItems`
on arrays rather than re-checking them afterwards — see "Bounds belong in the
schema, invariants belong in the script" above, and
[`review-fix.workflow.mjs`](../examples/review-fix/review-fix.workflow.mjs) for
the shipped version. An impossible declaration (`minItems` above `maxItems`, a
bound on the wrong type, a `pattern` that does not compile) is refused before the
first child call, so it cannot burn the retry budget and surface as an
unexplained exhaustion.

## Bounded loop plus judge

Two shipped loops use this shape: `review`'s interrogation rounds and `plan`'s
drafting rounds. Both follow the same three rules —

1. the judge returns a **declared enum** plus the concrete gaps or defects that
   justify another round, never prose the script greps;
2. each round returns the **complete document**, so the script forwards one text
   instead of merging several, and the judge's free text reaches the next round
   verbatim;
3. the result records **which condition stopped the loop** — the judge's verdict
   or the round cap — because those two outcomes mean different things to whoever
   reads the run.

```js
const maxRounds = 3;
for (let round = 1; round <= maxRounds; round += 1) {
  const work = await agent(`Round ${round}: ${input}`, { label: `work:${round}` });

  const judge = await agent(`Is this complete? Reply with done boolean.\n${work}`, {
    label: `judge:${round}`,
    tools: [],
    maxToolCalls: 0,
    schema: {
      type: "object",
      required: ["done"],
      properties: { done: { type: "boolean" } },
    },
  });
  if (judge.done) return { ok: true, stoppedBy: "judge", round };
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
  async (state) => ({ ...state, classified: await agent(`Classify ${state.extracted}`) }),
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
    (perspective) => () =>
      agent(`${perspective} judge: ${input}`, { label: `judge:${perspective}`, schema: VERDICT_SCHEMA }),
  ),
);
const passed = votes.filter((vote) => vote.verdict === "pass").length;
return { ok: passed > votes.length / 2, passed, total: votes.length };
```

Choose majority or unanimity explicitly. If any panel slot fails and partial
panels are not accepted by requirements, let the group fail closed.

## Loop until dry

```js
let emptyStreak = 0;
for (let round = 1; round <= 5; round += 1) {
  const sweep = await agent(`Find remaining work, round ${round}`, { label: `sweep:${round}` });
  const measured = await agent(`Count evidenced remaining items in this report:\n${sweep}`, {
    label: `measure:${round}`,
    tools: [],
    maxToolCalls: 0,
    schema: {
      type: "object",
      required: ["remaining"],
      properties: { remaining: { type: "number" } },
    },
  });
  const remaining = measured.remaining;
  emptyStreak = remaining === 0 ? emptyStreak + 1 : 0;
  if (emptyStreak >= 2) return { ok: true, stoppedBy: "dry", round };
}
return { ok: false, stoppedBy: "round-cap", error: "Dry state was not proven" };
```

Always separate the measured exit condition from the safety cap and record
which condition stopped the run.
