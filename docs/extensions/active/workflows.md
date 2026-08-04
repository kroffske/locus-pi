# Workflows — Pi-native Dynamic-Workflow Runtime

**behaviorStatus:** `active`
**defaultEnabled:** `true` (default-loaded via `package.json#pi.extensions`)
**ownershipStatus:** `locus-specific`
**risk:** `critical`

> **Canonical DSL / authoring reference.** This file is the single source of truth for
> writing a `<name>.workflow.mjs`: the DSL surface, options, schema, trust model, name
> resolution, run commands, result/journal layout, and the "what is NOT supported"
> contract. Co-located pointer for in-extension reach: `extensions/workflows/AUTHORING.md`
> (a thin link back here). To AUTHOR a new workflow from requirements, delegate to the
> `workflow-author` catalog agent (`.agents/agents/workflow-author.md`); its persona
> carries the operational contract inline and points here for edge-cases. Any other
> copy should be a thin link to this page, not a fork. The in-extension pointer is
> `extensions/workflows/AUTHORING.md`.

---

## What it is

A Pi-native dynamic-workflow runtime that provides a DSL (`agent / fusion / publishArtifact /
consumeTextArtifact / awaitOperator / parallel / pipeline / phase / log / promptFile / workspace`)
for orchestrating catalog-agent sessions through the existing
`task / createAgentSession` path and retaining their evidence under one run root.
The same extension owns an opt-in direct `fusion` tool for the main Pi session;
it is registered but inactive until the operator configures and enables it.

One way a workflow reaches a model:

- **`agent()`** — spawns a full catalog or workflow-local child session and returns
  its exact non-empty final text, routed through the same code path as the `task`
  tool. With `opts.choice` it returns one declared exact string; with
  `opts.handoffs` it returns a bounded list of complete text work units. Both use
  the runtime-owned repair path. Trusted compatibility scripts may still use
  `opts.schema` for a larger validated value.
- **`fusion()`** — validates a panel of 2–10 explicit model selectors, runs its
  isolated members through ordinary full-tool `agent()` calls, and asks a separate
  judge call for one final answer. It receives no ambient conversation history.

There is no direct one-shot completion node: `llm()` existed until 0.2.x and was
removed so every physical model call keeps the same agent-session evidence path.
Fusion is a composition of that path, not a second transport.

Every `agent()` call in a workflow script routes through exactly the same code path as the `task` tool:

```
agent(prompt, opts)
  -> createWorkflowAgentRunner (workflow-agent-bridge.ts)
  -> createAgentRunRequest (agent-runner.ts)
  -> executeAgentRunBoundary (agent-runner.ts)
  -> createAgentSdkSessionExecutor (agent-sdk-host.ts)
  -> createAgentSession (Pi SDK host)
```

Workflow `.mjs` scripts execute as reviewed trusted JavaScript in the Pi host's
main Node process. Static `node:` imports are available by default. Local,
package, dynamic and source-anchored module behavior requires an explicit
`meta.identityCoverage: "entry-only"` evidence downgrade; it still has full Node
module access and can therefore use host filesystem, subprocess, network, or
other capabilities. Neither identity policy is a sandbox. `dsl` is the intended
authoring handle; it is not enforced.

---

## STATUS

**Runtime works — proven live.** The agent bridge, journal, runner, examples, and test
suite are implemented and unit-tested against a mocked `createAgentSession` (same injection
pattern as `agent-sdk-host.test.ts`), AND verified end-to-end live: running the `live-smoke`
example through `pi` with a real model spawned two real child agent sessions that completed
with real session ids. See "Run a real workflow (live)" below.

### PENDING SEAMS

| Seam                                | Location                                                                                                    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded concurrency                 | `extensions/workflows/runtime/workflow-runtime.ts` `runScheduled()`                                         | DONE. `parallel()`/`pipeline()` run through a bounded worker pool (`SCHEDULER_WIDTH = 4`) that preserves input ordering; width bounds each `runScheduled` call, not globally, so nested fan-out used to multiply. The **global limiter** now exists: every run applies `DEFAULT_WORKFLOW_BUDGET.concurrency` to the leaf `AgentConcurrencyGate` (see "Run budget"). `SCHEDULER_WIDTH` tuning and worktree-isolated real concurrency remain a future scheduler task.                                                                                                                             |
| Git-worktree isolation              | `workflow-agent-bridge.ts`, `workflow-worktree.ts`                                                          | DONE for `workspaceMode: "worktree"` / `"temporary-worktree"`: each isolated agent gets a retained `.pi/locus-pi/workflows/<runId>/worktrees/<call-id>/` git worktree before child execution. Merge-back remains out of scope.                                                                                                                                                                                                                                                                                                                                                                  |
| Trusted script execution            | `extensions/workflows/runtime/workflow-runner.ts` `loadWorkflowScript()`                                    | Author scripts are **reviewed trusted input**. Default `self-contained-static` restricts declared module edges for identity evidence; explicit `entry-only` keeps full modular Node.js access. Neither mode isolates capabilities. A real isolate is a future seam, not current protection.                                                                                                                                                                                                                                                                                                     |
| Owner-default agent + model routing | `extensions/workflows/runtime/workflow-runtime.ts`, `workflow-agent-bridge.ts`, `.agents/agents/default.md` | DONE. Bare `agent(prompt)` resolves to catalog agent `default`; explicit `agent(prompt, { agent: "quick_task" })` keeps the mechanical worker path. Model routing resolves `opts.model` → `opts.modelRole` → the agent's frontmatter tier → `ctx.model` through `ctx.modelRegistry.find`, and the resolved model is what `createSession` receives. An unresolvable concrete `provider/id` selector fails the call by name with no child spawned; an unassigned role degrades to `ctx.model` and records the degradation. `agent_end` carries `executedModel`, read back from the child session. |

---

## Curated Package workflows

| Workflow             | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Minimal **live proof**: 2 full-tool agents each do one small tool action and report. Cheap (~2 agents). Run it to confirm the host can actually spawn child agents; verify via `result.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `requirements-grill` | **Requirements refinement**, and three agents declared in one `GRILL_AGENTS` roster. A `scout` searches the repository and reports what exists, a `challenger` reopens the files that context names and attacks the request, and a `synthesizer` composes the handoff with the full inherited tool set. Nothing loops and nothing branches, so no stage declares an answer shape. The script owns no search of its own: the keyword-guessing `rg` call it used to run is gone, and ripgrep is no longer a package requirement. An empty request fails before the first child; its length is bounded by the host's `WORKFLOW_INPUT_MAX_CHARS`, not a second time by the entry. The synthesizer's exact text is the result.                                                                                                                                                                                                                                                                                                                                                                                            |
| `review`             | **Question-led code review**: semantic text first reaches a shaped clarifier. It either continues or persists exact intent/questions and stops; a later text answer call attaches those two refs through host continuation. Five sequential agents then resolve scope, inventory the change, plan review units, ask falsifiable questions, and verify them independently. Runtime bounds every handoff and accepts runtime-owned `review.md` as exact verifier text; coverage ids are prompt discipline the verifier reports, and there is no publisher agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `review-fix`         | **Human-gated remediation**: semantic text plus host continuation supplies the immutable terminal `review.md` answer from a Package `review` run. A shaped selector plans 1–20 finding units and dependencies; deterministic code validates ids, notes, edges, cycles, and context bounds before writers. Stable topological order gives one writer to each selected finding, then a checker and fresh dependency-aware re-review run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plan`               | **Task to outcome-first accepted plan**: planning agents are prompted not to edit. A `scout` maps the repository, then a `planner`/`critic` loop defines one primary result before deriving steps: outcome type, consumer, form and location, required content or behavior, usability proof, and supporting evidence. Every step is one bounded agent subtask with explicit `Context:`, one `Question:`, and one `Output:`; dozens of item-sized steps are valid, and distinct reasoning over one source stays split. The critic rejects plans whose steps can pass without producing the result, hidden meaning-changing assumptions, oversized multi-question steps, and repeated work that is purely mechanical. At the bounded round cap, the operator is told to continue the same run with guidance instead of editing the retained draft.                                                                                                                                                                                                                                                                     |
| `plan-implement`     | **Accepted plan to verified primary result**: one host-verified continuation artifact, pasted plan text, or one text file supplies the plan. Deterministic code extracts routing structure — one unambiguous `## Outcome`, `### S<n>` blocks, `Depends on:` closure, and the optional legacy-compatible agent-subtask contract — restores selected plan order, and publishes `implementation-tasks.md`; agents own the plan's meaning and the final judgment. Each selected step, up to 80, gets one writer whose prompt repeats only that step's context, semantic question, and required output, followed by an independent reviewer. The final checker returns structured selected-step and repository command statuses; deterministic control flow refuses `complete` after any failed or unrun check, evidence gap, run-attributable unexpected change, or non-ready primary result. One bounded reconciliation may repair any terminal gap, including a missing result after all steps are done. The primary output is `workflow-summary.md`; `implementation-report.md` remains supporting per-step evidence. |

`review` always receives a non-empty semantic string. A shaped
clarifier decides `continue` or `needs_operator`. Continue starts the five review
stages and publishes the exact intent. Needs-operator publishes exact
`intent.md` and readable `clarification-questions.md`, returns both complete
refs, declares `awaiting_operator` without changing that returned payload, and
stops. A later invocation carries only non-empty answers in `input`
and attaches those exact same-origin refs through host `continuation`; the
runtime verifies and copies them before workflow code starts. The workflow then
requires the successful source run's terminal result to name the same complete
refs, publishes `clarification-answers.md`, and runs the same five stages.

Every handoff remains exact text. The runtime publishes `scope.md`,
`inventory.md`, `units.md`, `questions.md`, and finally the verifier's exact
answer as `review.md` under the current run's artifact store. The verifier treats
questions as hypotheses, reopens code, callers, tests, and documentation, and
turns only confirmed problems into `### F<n>` findings. No publisher agent,
task-local report, model-written status envelope, or path extraction participates.
Handoffs pass forward as exact text. The entry orchestrates and bounds — non-empty
text and per-stage character caps — and does not grade Markdown grammar: stable
`C<n>` ids and the `C<n>: U<n>; ...` reconciliation ledgers are prompt discipline
that the interrogator and verifier reconcile and report, not a host gate that ends
a run. The one inventory shape the entry reads is `## No changes`: declared alone,
it finishes the run with a `no-changes` result instead of spending unit planning,
interrogation, and verification on an empty scope. Shaped answers that must be
machine-read still use `agent({ schema })`, where the runtime re-asks the child
with the validator errors before failing closed.

The unit planner, interrogator, and verifier may also use `ast_index`, an
allowlisted argv tool over the installed `ast-index` binary, for code-symbol
relationships. Its database lives in the user cache directory, so index
refreshes never touch reviewed source. A missing binary or index degrades to
`grep`/`find` and is recorded as a coverage limit instead of blocking the
review.

The two review workflows have independent package directories:
`extensions/workflows/examples/review/` and
`extensions/workflows/examples/review-fix/`. The reader algorithm lives in
`review/README.md`, and `extensions/workflows/examples/README.md` inventories
every shipped example. Both entries write their stage prompts inline under one
`COMMON` contract; `review` additionally keeps the two role charters
`resources/interrogator.prompt.md` and `resources/verifier.prompt.md`, and
`review-fix` keeps none. A charter file carries the stable role instructions and
the dynamic handoffs for its one stage. `promptFile()` resolves paths relative to
the original workflow source, rejects lexical or symlink escapes, copies bytes
once into the run directory, and records SHA-256 evidence.

The remediation call keeps operator meaning and host state separate:

```json
{
  "name": "review-fix",
  "input": "Fix the pagination defects; keep the public API unchanged.",
  "continuation": {
    "originRunId": "...",
    "artifactRefs": [{ "runId": "...", "artifactId": "...", "name": "review.md", "sha256": "..." }]
  }
}
```

The continuation must contain exactly one complete immutable reference named
`review.md`. The host verifies all four fields, that the source run succeeded,
and that the reference is present in that run's terminal projection, then copies
the bytes into the new run with source lineage before workflow code starts. Since
2026-07-29 the entry checks the count and the name and reads those verified bytes:
it no longer re-derives the host's proof, and no longer asserts that the bytes
came from the `verify-review` stage of a Package workflow named `review` —
provenance the host does not check and no agent can. The operator picks the source
run through the closed `continuation` control and the host verifies what they
picked; the accepted residual risk is remediating against a review from some other
run, which re-running with the right source fixes. See `## Curated Package
workflows` below for the same trade in `plan` → `plan-implement`.
A full-tool selector receives the operator text and immutable review,
then returns 1–20 `{id,note,dependsOn}` units through the fail-closed shaped
agent boundary. Deterministic code bounds all notes and handoffs, parses complete
`### F<n>` blocks, rejects duplicate/unknown ids, duplicate/self/unknown edges,
unselected dependencies and cycles, and computes stable Kahn order with original
review order as its tie-break.

One scope resolver receives only the selected complete finding blocks.
Exactly one sequential write-capable agent then owns each selected finding, so
overlapping mutations have a visible order and one accountable writer. A separate
checker reopens the full
diff and may call `repository_check` with only a `package.json` script whose exact
command was frozen when the workflow runner was created, before any writer. A
script-map addition, removal, or modification is refused in both the launch checkout and the
materialized snapshot. The host, not the model, supplies argv, timeout, output bound, and a
disposable external Git worktree containing the current tracked/untracked bytes;
initialized submodule source is recursively materialized without copying Git
administrative metadata. The operator checkout is never the command cwd. A fresh re-review
receives the immutable original review, bounded worker answers, and check
evidence; it reopens the source and reports every original
finding, dependency, and regression. `agent({ artifact })` gives the automatic answers stable names:
`scope.md`, `worker-F<n>.md`, `check-evidence.md`, and `re-review.md`. The final
`re-review.md` answer is also the workflow result. No input helper, unit planner,
verifier/publisher pair, `fix-report.md`, or task-local publication remains.

All `review-fix` agents run in the operator's launch checkout with
`workspaceMode: "project"` rather than in a linked worktree. That is a
deliberate trade: the review may cover staged, unstaged, or untracked work that
exists in no commit, and a worktree at some commit would hand the fix agent
different code than the one that was reviewed. The compensating boundaries are
that the operator starts the workflow explicitly, chooses every finding id,
receives one writer per finding, and gets independent check evidence plus a
fresh re-review. Prompts forbid commit, push, merge, deploy, and discarding
uncommitted work the agent did not create; every change stays uncommitted for an
ordinary diff review. Scope resolution, checking, and re-review prompts forbid
project edits, but those agents still receive the full tool set. A declared package
script is operator-owned executable code, so the disposable worktree is a
mutation boundary for the checkout, not an OS/network sandbox.

Both entry scripts use only the injected DSL and retain default
`self-contained-static` identity; `review-fix` no longer imports a helper. Prompt
resources still receive immutable run copies and SHA-256 evidence. Repository
and private-forge evidence acquisition remains child-agent-owned. Prompt text and
permission metadata are not a sandbox; resource, artifact, or child execution
failure remains fail-closed.

Runtime-owned Markdown under `outputs/` is the human-facing evidence. Mandatory
`runtime/result.json`
remains the machine-readable run envelope, while
`.pi/locus-pi/workflows/<runId>/runtime/artifacts/index.json` is the canonical map from
logical artifact identities to digest-bound bytes.

These six names are what `extensions/workflows/examples/` currently holds, and
that directory **is** the Package registry — a workflow is registered by the
existence of its entry file, exactly like a project one. The set stays small
because it is a public surface: `package.json#files` still decides what an
install ships, and a package-boundary test fails when the two disagree, so a
workflow that resolves in a checkout can never be missing after `npm i`.

`plan` and `plan-implement` are the second curated pair, and the seam between
them is the same shape as `review` → `review-fix`, which since 2026-07-29 makes
the same trade described below. `plan` returns the accepted
plan text, which the runtime retains as `plan.md`; `plan-implement` takes that
artifact's complete `{ runId, artifactId, name, sha256 }` reference through host
continuation, and reads the bytes the host verified and copied, at any length.
Entry code used
to re-derive that proof and additionally require the bytes to equal the source
run's terminal result — which distinguished the accepted plan from a same-named
draft of an earlier round. That check was removed on 2026-07-28 as an accepted
trade: it cost every reader of the entry, and the failure it prevented is a run
implementing an unaccepted draft, which replanning corrects.

`review` and `review-fix` carried the same duplicate and one further check on top
of it: that the consumed bytes were the terminal answer of a Package `review`
stage of a named phase. Both were removed on 2026-07-29 by owner decision. The
digest half was the host's job already — an unprojected reference, or bytes whose
digest no longer matches, is refused while the continuation is bound, before the
module starts. The semantic half asserted provenance the host does not check and
no agent can; the operator picks the source run through the closed `continuation`
control and the host verifies what they picked. The accepted cost is a run that
remediates against a review, or answers clarification questions from, some other
run — which re-running with the right source corrects.

`plan` declares its three participants in one frozen `PLAN_AGENTS` roster —
`scout`, `planner`, `critic` — carrying each agent's capabilities beside what it
receives and returns, so the cast is readable without following the control flow.

Every accepted plan starts with `## Outcome`. That section names the primary
result and the evidence that makes it useful, so `plan-implement` carries the
operator's intended result through every writer, check, and terminal grade. A
technical completion report is supporting evidence unless the task explicitly
asked for one.

Each new `### S<n>` block also carries `Context:`, `Question:`, and `Output:`.
That is the execution boundary: one agent receives the smallest useful context,
answers one semantic question, and writes one uniquely named result. A source may
therefore appear in several steps when extraction and interpretation need
different reasoning. Combining those results is not hidden runtime behavior; it
is another ordinary step with declared dependencies. `plan-implement` still
accepts older plans that omit all three lines, but rejects a partial contract, a
missing concrete output path, or two explicit subtasks sharing one output
instead of guessing what the boundary meant.

Planning prompts forbid project edits. Every `plan` and `plan-implement` child
still receives `tools: ["*"]`; the stage prompt says whether that agent should
modify files. The workflow publishes a deterministic
`implementation-tasks.md` snapshot after selection and after every review
decision; stable attempt labels let `--resume` replay completed calls instead of
applying accepted tasks again. Structured check evidence feeds deterministic
terminal validation: no failed or unrun observed check, evidence gap,
run-attributable unexpected change, or missing primary result can be projected
as complete. The final checker agent owns whether that result satisfies the
accepted outcome. The primary terminal document is
`workflow-summary.md`, which points to the result and its proof;
`implementation-report.md` remains the detailed step record. `plan`'s one loop ends on a declared enum rather
than on a scan of model prose, and the run journal records whether the critic or
the round cap stopped it. The operator-clarification round it used to run first
was removed on the same day: the loop no longer stops to ask, and an open decision
is recorded as a stated assumption only when one interpretation is clearly
safer; an ambiguity that changes the primary result prevents acceptance. The
round cap is the one operator pause left, added 2026-07-30: a stalled loop retains the
draft with its open defects and declares a handoff, so the operator accepts the
last draft or steers the same run with continuation guidance. Editing the
retained `plan.md` and starting a fresh `plan` run does not bind those answers as
operator guidance and is explicitly discouraged by the handoff.

Pipeline maps:

- `plan`:
  [SVG](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/plan/plan-pipeline.svg)

The generated Excalidraw triple every curated workflow used to carry — a
generator, an `.excalidraw` document, and an exported PNG — was removed on
2026-07-28 together with its contract. The remaining five maps are being
re-authored as hand-written SVG in the shape `plan` now sets.

## Authoring patterns

New workflows use the progressive-disclosure cards under
`skills/locus-pi-workflows/references/`. The index maps requirements and common
names to small standard topologies; the author reads only the selected card.
Cards are algorithms and snippets, not Package workflows. Saving a local workflow
does not add it to the Package registry.

The older `extensions/workflows/references/patterns.md` remains an advanced
compatibility reference for trusted scripts that already use raw schemas and
validators. It is not the standard generation target.

This repository dogfoods that boundary with ignored project files under
`.pi/workflows/`: `locus-plan.workflow.mjs` exercises clarification, planning,
digest-bound split-run execution, and per-unit implementation; `test-code.workflow.mjs`
separates testcase design, test implementation/execution, and failure
attribution among independent agents. Their independent final verifier and
attribution agents are instructed not to edit and can run frozen
`repository_check` scripts; bounded intent, plans, units, predecessor results,
execution evidence, and final inputs fail closed. They are local operational examples, not
tracked source, curated names, documentation shipped in the npm tarball, or
public package support promises.

Standard scripts pass narrative results as exact text, use
`agent({ choice: [...] })` when JavaScript must select a branch, and use
`agent({ handoffs: {...} })` when discovery must produce bounded complete text
units for visible downstream workers. Raw `schema`, `validate`, parsers,
renderers, and custom recovery remain outside the standard profile. Only files
in the curated `examples/` registry are Package workflows.

Saved workflow names such as `live-smoke` use one first-wins resolver for
execution, `/workflows list`, and `/workflows info <name>`. Starting at the command's
working directory and walking upward to the project root, each level is checked in this
order:

1. `./.pi/workflows/<name>.workflow.mjs` — human source `Project`; the canonical
   Pi-native authoring target.
2. `./.claude/workflows/<name>.workflow.mjs`, then
   `./.agents/workflows/<name>.workflow.mjs` — human source `Project`; additional
   project directories for repositories that already keep agent assets there. The
   accepted file is the same pi-native `<name>.workflow.mjs`: the resolver and the
   catalog scan build that exact filename and nothing else, so a `<name>.js` in
   these directories is not found. A script authored against another host's
   workflow DSL is **not portable as is** even when its filename matches — it
   would expect globals and primitives this runtime does not provide (for example
   an `args` global or a `budget` object), and here `agent()` returns the child's
   exact text unless the call declares a `schema`. Port such a script to the DSL
   contract below rather than dropping it in.
3. `~/.pi/workflows/<name>.workflow.mjs` — human source `User`.
4. The packaged examples directory — human source `Package`. Every
   `<name>.workflow.mjs` under `extensions/workflows/examples/` is a Package
   workflow; currently `live-smoke`, `plan`, `plan-implement`,
   `requirements-grill`, `review`, and `review-fix`.

The first eligible source for a name wins and its exact resolved path is retained.
Project and user directories are scanned on each resolve/list/info call, so adding or
removing a valid file changes the next result and removing a shadow reveals the next
source. The packaged examples directory is scanned the same way, so adding or
removing a `<name>.workflow.mjs` there is the whole of adding or removing a
Package workflow. The scan descends one directory level, which is how a workflow
keeps prompt resources or its diagram beside its entry, and it accepts only
regular files, so a symlink never resolves out of the package. An already-open
catalog selection is revalidated, so a precedence change fails explicitly instead of
switching paths silently.

To run your own script, pass an explicit project-relative `scriptPath` ending in `.mjs`.
At resolution time, existing explicit targets and project saved-name candidates are checked
twice: lexically and by canonical `realpath`. An external symlink observed by that check is
rejected before module evaluation. An internal symlink remains usable after its physical
target is verified inside the project; the existing lexical path remains stable as the
recorded source path. Personal and packaged sources keep their documented roots. The check
is not atomic with the later Node import: workflow files are trusted input and must not be
replaced concurrently during launch. This is path validation, not a filesystem sandbox.
Legacy `script` strings normalize to either `name` or `scriptPath`; arbitrary inline
JavaScript is not supported.

## How to run

### `/workflows` command

`/workflows` is the canonical visible workflow command. Bare `/workflows`
opens its command menu with all eight exact verbs — `dashboard`, `list`, `info`,
`status`, `result`, `run`, `continue`, and `stop` — and a description beside
each verb when interactive select is available in TUI; RPC, headless hosts, and
TUI without select receive the same help as a typed command fallback. Direct typed forms such as
`/workflows run <name>` remain available. Flat `/workflow-*` commands route to
the same owners as compatibility aliases; they remain in place until parity
with the unified command is proven, and are not removed as part of this menu.

```
/workflows                        open the canonical command menu (or typed help fallback)
/workflows dashboard              persisted run → stage → evidence viewer
/workflows list [query]           current first-wins workflows + run-specific immutable history
/workflows info [name]            explain discovery, metadata, trust, DSL, agents, and model routing
/workflows status [runId]         interactive persisted viewer and stage evidence
/workflows result [runId|last]    whole text the run finished with, scrollable and untruncated
/workflows run live-smoke         start one background workflow (returns editor)
/workflows continue <runId>       answer and continue an actionable handoff
/workflows stop [runId|last]      request cancellation; terminal state follows settlement
/workflows run live-smoke --resume <runId>  replay that run's recorded agent calls (see "Resume and replay")
```

### Direct Fusion from the main session

Fusion also has a model-callable `fusion` tool. It is disabled by default, so it
does not enter the active tool list or the parent model's tool prompt until an
operator explicitly enables it.

```text
/fusion                                      # interactive menu or passive status
/fusion configure                            # choose 2–10 members and one judge
/fusion set --members provider/a,provider/b --judge provider/judge
/fusion enable
/fusion disable
/fusion status
/fusion run <complete standalone question>  # manual call through the same runner
```

The interactive selector reads `modelRegistry.getAvailable()`, so it shows only
models the current Pi host can actually use rather than every model known to a
provider. Configuration is project-local at
`.pi/locus-pi/fusion/config.json`. Members must be unique, and the judge must be
different from every member. Enabling fails closed when the roster is incomplete
or a selected model is no longer available.

The tool accepts `question`, optional explicit `context`, and an optional final
`output` instruction. It never forwards ambient session history. A direct run
uses the same full-tool Fusion calls and writes the same packet,
answers, journal, result envelope, and readable output under
`.pi/locus-pi/workflows/<runId>/` as the Workflow DSL primitive. Disabling removes
`fusion` from Pi's active tools immediately while leaving `/fusion` available for
configuration.

Every finished-run surface is bounded on purpose: the chat digest caps a line at
160 characters because it enters model context, and the live panel clips to the
terminal width. So a run whose result **is** prose — a review, a plan, an answer —
writes that text verbatim to `outputs/workflow-result.md`, and both the digest
and the panel name that file plus the command that opens it. `/workflows result`
(flat alias `/workflow-result`) opens the full text in a scrollable read-only screen:
`↑/↓` and PageUp/PageDown scroll, Home/End jump, Esc closes. A host without custom
UI gets a bounded preview plus the exact path, which is the copy that is never
truncated. The native workflow tool's operator card also renders this exact text
without clipping, while its model-facing content remains bounded. Structured
(non-text) results stay in `runtime/result.json`, which already pretty-prints them.

A run that ends badly and produced **no** prose result — a script returning a
structured `{ ok: false }` is the common case — gets the same treatment against a
different command. Its verdict line carries the failure summary and is clipped
like any other, so the digest and the panel add
`read the full reason: /workflows status <runId>`, which prints the structured
result the reason actually lives in. `/workflows result` is deliberately not
offered there: it refuses a non-prose result, so pointing at it would send the
operator to a dead end.

`/workflows result` and `/workflows status` accept the short run suffix every
surface prints (`run #98cc` → `/workflows result 98cc`), `last` for the newest run,
or a full run id. A short suffix matching more than one run is refused with the real
match count and the listed candidates — never opened as the wrong run, and never
reported as missing when runs were found.

The same owners are also available as flat commands:

```
/workflow-run <name|path> [input]
/workflow-stop [runId|last]
/workflow-list [query]
/workflow-info [name]
/workflow-status [runId]
/workflow-result [runId|last]
/workflow-continue <runId> [--answer <text>]
```

Pi's native slash-command filtering exposes these complete names and Tab selects
them without first entering `/workflows`. Direct typed `/workflows <subcommand>`
forms remain supported and keep their argument completion for workflow names,
persisted run ids, `last`, and replay ids. Flat commands are compatibility
aliases, not a second implementation; keep them until parity with the unified
menu is proven. Catalog queries, paths, and semantic input remain free text.

`/workflows run` adapts to the host's run mode. In `tui` and `rpc` the session
outlives the turn, so the run is detached: the command returns immediately, the
live panel streams it, and `/workflows stop` can cancel it. Flat `/workflow-run`
and `/workflow-stop` commands remain compatibility aliases. In the one-shot output
modes (`pi -p`, `--mode json`) the host disposes the session when the turn ends —
a detached run would lose the ctx its child sessions need — so the command holds
the turn open until the run settles and its result is persisted. A headless
invocation therefore blocks for the whole run and there is no concurrent
`/workflows stop`; cancel it with the host's own interrupt.

An actionable `awaiting_operator` handoff opens directly in the primary editor
after Pi becomes idle — automatically only for runs this session launched,
their continuations included. A question left by an earlier session stays in
its run's evidence until asked for: open the `/workflows` menu and choose
`continue` for the oldest pending one project-wide, or type
`/workflows continue <runId>` for a named one. The menu provides contextual
workflow/run selection for `info`, `result`, `run`, `continue`, and `stop`, not
one combined picker. Multiple handoffs are oldest-first and show
`Question 1 of N`; answering launches one integrity-checked continuation before
the next item opens. Escape is an answer, not a postponement: the continuation
receives the question list with an operator-declined note, keeping any answers
given before the refusal. A retryable handoff — one whose continuation consumed
an answer and then failed — never reopens unprompted; the idle pump prints a
one-line notice (once per session) naming the run; `/workflows` then opens the
menu so `continue` can reopen it.
Only `/workflows stop` cancels a workflow; flat `/workflow-stop` remains a
compatibility alias for the same cancellation owner.

`/workflows continue <runId>` collects answers interactively in TUI and RPC;
flat `/workflow-continue` remains a compatibility alias. `--answer` is the
explicit non-interactive path and accepts exactly one
question: closed selections require an exact label, while custom-enabled
questions accept other non-empty text. Multi-question handoffs fail closed
instead of guessing how one string should be distributed.

Mode behavior stays explicit:

| Pi mode            | Question projection                            | Answer collection                          |
| ------------------ | ---------------------------------------------- | ------------------------------------------ |
| TUI                | Automatic primary-editor select/text component | Arrows, Enter, or inline custom text       |
| RPC                | Command/static projection                      | Native bidirectional extension UI requests |
| JSON/print         | Readable one-way lifecycle output              | `/workflows continue … --answer …` only    |
| Embedded child SDK | Existing `session.subscribe(...)` observation  | Not applicable                             |

Pi 0.82.0 is the minimum supported host for automatic questions. Locus
serializes its own inline components and rechecks the current idle session before
mounting. Pi exposes no global custom-UI lock for unrelated third-party
extensions, so `/workflows` opens the recovery menu if another extension
displaces the question.

Every run is persisted to `.pi/locus-pi/workflows/<runId>/`. The runner creates
the non-symlink `outputs/`, `workspace/`, and `runtime/` directories and writes
the first `runtime/journal.ndjson` line before it
announces the RunID; initialization failure announces no start and launches no
child. The start surface reports the resolved run directory, which matters when
the terminal is viewing another checkout or worktree. `runtime/result.json` appears when
the run finishes, so `status` works across sessions and after the fact.

### Persisted run artifacts and viewer

The canonical artifact inventory is
`.pi/locus-pi/workflows/<runId>/runtime/artifacts/index.json`. Every record includes a
logical id/name, media type, byte size, relative path, stage, provenance, and
SHA-256. Its portable identity is always the complete object
`{ runId, artifactId, name, sha256 }`; a run id or path alone is not an artifact
reference.

Every `agent()` attempt receives a stable `call-<n>` identity before scheduling.
The runtime persists the exact non-empty child text under `runtime/artifacts/answers/`.
A fresh child session must also export a Pi session transcript under
`artifacts/transcripts/<callId>/` and a JSON result envelope under
`artifacts/results/<callId>/`; missing evidence makes the call fail before its
terminal `agent_end` is emitted. A replayed call writes a new answer record with
`provenance: "replay"` and its source run id, but invents no transcript or result
envelope because no child ran.

Authors can add or connect deterministic text evidence through four surfaces:

- `publishArtifact(name, text)` writes bounded workflow-authored Markdown under
  `runtime/artifacts/published/`, projects it into `outputs/`, and returns its
  full reference.
- `publishPrimaryArtifact(name, text)` does the same while explicitly declaring
  the run's one primary semantic document. A second declaration fails closed.
- `consumeTextArtifact(ref)` accepts only a full prior-run reference, requires the
  source run to have `ok:true`, requires the exact ref in its terminal
  `artifactRefs` projection, verifies index identity, media type, size, digest,
  path confinement, and bytes, then copies them under `runtime/artifacts/inputs/` with
  the original reference recorded as lineage. Self-reference is refused.
- `agent(prompt, { artifact: "report.md" })` names the automatic answer artifact.
  Without `artifact`, the runtime derives a safe name from the label or agent.

Artifact names are 1-128 ASCII characters, begin with a letter or digit, and
otherwise contain only letters, digits, `.`, `_`, or `-`; they are logical names,
not paths. Text artifacts are limited to 2 MiB. Repeated logical names are
allowed because `artifactId` is the portable identity; duplicate artifact ids or
destinations are refused. The source run target and source artifact kind/stage
returned by `consumeTextArtifact()` let a consumer enforce workflow-specific
provenance rather than trusting a conventional filename. The read result also
projects the successful source run's terminal JSON result and validated
`artifactRefs`, so a stricter consumer can bind structured prepare refs or prove
that referenced bytes were the terminal string output rather than merely a
same-name indexed artifact.

The artifact index is single-owner and append-only during a run. External index
changes, duplicate identities, symlink escapes, unsafe names, oversized text,
tampered bytes, or malformed transcript headers fail closed.
The same owner resolves the project root and rejects symlinks in every ancestor
through `.pi/locus-pi/workflows/<runId>` before any artifact read, write, or
consume, preventing a redirected canonical root.

At run completion, `runtime/result.json` and the model-callable `workflow` tool project
up to the newest 20 explicitly published/primary refs as `artifactRefs`; an
`artifactRefsOmitted` count makes truncation explicit. Each projected item is the
same complete `{runId, artifactId, name, sha256}` identity verified by the index.
This bounded projection is the handoff for a later workflow; the full inventory
remains in `runtime/artifacts/index.json` for inspection only. The caller must use a
terminally projected ref, not infer an id from a logical filename or consume an
index-only record.

In an interactive Pi TUI, `/workflows dashboard`, `/workflows status`, and
`/workflows status <runId>` open the persisted run viewer. It navigates
run → stage → evidence → content from disk only. Evidence rows include automatic
answers, child transcripts, child result envelopes, workflow-published and
consumed text, plus stage journal logs. Content is re-read through the index and
digest-verified before rendering; missing, malformed, changed, oversized, or
tampered evidence is shown as unavailable rather than guessed. RPC, print/no-UI,
and TUI hosts without custom UI retain the bounded static status/detail blocks.

Before module evaluation, the runner reads the resolved `.workflow.mjs` bytes,
AST-checks their declared dependency shape, computes SHA-256, and writes a
read-only `script-<sha256>.workflow.mjs` snapshot inside the run directory. A
source with no coverage declaration defaults to `self-contained-static`: only
literal static `node:` imports/re-exports are accepted, and the retained snapshot
is the imported module URL. Local/file/data/bare imports, non-`node:` re-exports,
direct dynamic `import()`, direct/parenthesized `require()` and `import.meta` fail
before evaluation. The AST policy does not infer `createRequire` aliases,
eval-generated imports or other indirect host-code loading; reviewed authors must
declare `entry-only` for those behaviors even though the analyzer cannot prove them.

A reviewed modular script may explicitly declare the literal top-level field
`meta.identityCoverage: "entry-only"`. That hash-bound downgrade keeps a
hash- and run-qualified source import, including relative-import and `import.meta` base,
but dependency bytes stay unbound. `scriptSha256` always means exact entry bytes;
it is never a full behavior/environment hash.

Each version-2 `result.json` identity also records the policy, coverage,
`executionSource`, Node version/platform/architecture, sorted builtin imports and
unbound dependency descriptions. Tool, command and `/workflows status` surfaces
show the safe target reference, coverage, execution source, dependency counts,
snapshot basename and short hash. This structured target/identity metadata never
exposes the absolute `sourcePath` or internal target path; an accepted absolute
in-project input is reduced to its basename there. Node loader/runtime error text
can still contain paths and is not a privacy-redacted channel. Only the old
unversioned three-field identity reads
as `entry-only-legacy`; unknown/future or inconsistent v2 records are omitted.
The snapshot is verified after module evaluation and again after JSON result
detachment immediately before synchronous persistence. An observed mismatch
forces `ok:false`; these point-in-time checks are not an atomic filesystem or
same-owner race guarantee. A per-run module URL prevents one entry-only import
from poisoning a later run's entry cache. Editing self-contained entry bytes
between launches executes the new snapshot without `/reload`.

`self-contained-static` describes only declared source-module edges. Node
builtins still allow filesystem, subprocess, network, dynamic code and other host
effects, including indirect loaders the AST policy cannot enumerate. Identity
coverage is not isolation, runtime dependency closure or determinism.

The model-callable `workflow` tool declares Pi `approval: "exec"`; its native
approval details warn that the selected file has full host Node.js/module access
and no sandbox. Approval records consent but does not constrain the module.
`/workflows run` is an explicit operator command and does not pass through the
tool-approval path; `locus-pi` adds no second launch prompt or `decision` entry.

Pi 0.82.0 can invoke an extension command immediately while the parent agent is still streaming. Therefore `/workflows run` first checks the real command context `ctx.isIdle()` before target resolution, transcript creation, or workflow execution. A busy session fails closed with `Workflow not started: Pi is busy streaming…`; it sends no custom message and starts no workflow. The operator retries after the current response finishes. Read-only `/workflows list` and `/workflows status` do not create transcript messages and remain available. This guard is required because `sendMessage({ triggerTurn:false })` routes to `agent.steer()` when Pi is streaming, despite `triggerTurn:false`.

After the idle check, `/workflows run` claims one process-local background lease for the current session/project, launches `runWorkflowScript` without awaiting it, and returns control to the editor. A second interactive run in that stable session/project identity is rejected with the existing run id even across an extension reload, until the predecessor settles. The programmatic `workflow` tool remains awaited and headless, but registers a non-exclusive run controller with the same owner; it does not occupy the slash-command slot. `/workflows stop [runId|last]` is the sole operator cancellation command for either launch origin. Stop is idempotent and the UI says `stopping` until settlement. Once the controlling signal is observed as aborted, the runner persists `disposition.status:"cancelled"` even if trusted script code catches a child abort. `operator_stop`, `session_shutdown`, and unknown host aborts remain distinguishable reasons.

The background run installs a compact `belowEditor` widget. Its header identifies the workflow and run, the stage frontier preserves declaration order, and each stage is labelled only as `declared`, `reached`, or `current`; only an explicit `kind: "phase"` journal event makes a stage reached or current. Phase metadata on agent, group or log events remains grouping context. One active child row is rendered through the shared `AgentLivePanel`; parallel/group rows remain visible context headings but are not selectable. Round retries retain the same stage slot and add an `rN` marker. `/ps` opens the agents extension's shared fleet selector directly from the current `agentLiveStore`; widget render order never chooses its rows. Because rows of the last few completed runs stay drillable, the selector ranks the newest workflow run and every standalone agent first and puts earlier runs behind one `earlier workflow runs` label — nothing is hidden, only ordered. For the same reason a bare agent name resolves to that agent's row in the newest run: an agent that ran again matches its own retained row in every earlier run, and the operator means the run they are watching. An earlier run stays reachable through its own row id. A question that stops a run for a human names the run that is blocked inside the question block itself (`workflow <name> · run #<id> · awaitOperator`), as a body line rather than a badge, so a narrow terminal drops neither it nor the question counter. `Shift+Down` is an optional terminal shortcut, not the primary contract. `Enter` opens transcript output or a recorded replay answer whose digest was checked by the workflow event adapter. `Esc`/`q` close or go back without aborting. Workflow-owned rows carry explicit run provenance and expose no `x` action; use `/workflows stop [runId|last]`. Standalone agent rows retain their confirmed `x` behavior.

The detached run adapter and transcript callbacks carry the originating Pi session generation; late completion therefore cannot write through them into a new session. The progress component's live-store listener and spinner timer are instead session-owned resources: the extension disposes them synchronously on session start/shutdown and idempotently on terminal, error, and `finally` paths, even when a runner ignores abort and settles later. `session_shutdown` (including reload) also aborts active work. This lifecycle uses Pi's documented [`session_shutdown`](https://pi.dev/docs/latest/extensions#events), [`input`/`turn_end`](https://pi.dev/docs/latest/extensions#events), and [`setWidget(key, undefined)` cleanup](https://pi.dev/docs/latest/extensions#widgets-status-and-footer) seams, plus the one shared agent-row formatter.

Transcript persistence follows the Pi surface that started the run. The slash-command path publishes a run-boundary banner at launch and a bounded digest at settlement, both with `customType: "locus-workflow-run"`. When the workflow returns prose, it then publishes that exact text separately with `customType: "locus-workflow-result"`; this result message is intentionally untruncated so the operator can read and copy it directly from scrollback. Structured, non-text results do not fabricate a prose message and remain available through persisted evidence. The banner is what separates one run from the next in scrollback — it names the workflow, the run, and the wall-clock time, so two runs of the same workflow are never read as one stream. It is sent from `onRunStart` and only after a synchronous `ctx.isIdle()` recheck, because the operator can submit a prompt between the launch gate and the first journal event and `sendMessage` routes to `agent.steer()` while Pi streams, despite `triggerTurn:false`; a busy session simply gets no banner and the live widget still shows the run. No further `sendMessage` call happens while the run is active, because a long workflow can outlive the launch-time idle check. The lifecycle stays in memory while widget/status surfaces show live progress. After the workflow finishes and the completion UI is updated, the command awaits the real `ctx.waitForIdle()`, rechecks `ctx.isIdle()`, and synchronously appends the bounded digest followed by the optional full result before awaiting either send. There is no await between the final idle check and either send call, so Pi's synchronous routing appends instead of steering. The calls omit `deliverAs` and do not start or queue a model turn. Every published record is stored and participates in later LLM context.

The programmatic `workflow` tool never calls `sendMessage` while its tool output may be streaming. It buffers the same lifecycle and appends one digest to the single ordinary final `toolResult` text; Pi therefore persists it through the native tool-call transcript without an extra turn. Streamed progress updates remain presentation-only. Digests on both paths cap each line at 160 characters and keep at most 20 agent rows plus the terminal verdict and one evidence path, so a digest stays within 4096 characters; the separate command result message deliberately does not use those bounds. One agent occupies one row for the whole run: the row is written on `agent_start` and rewritten in place on `agent_end`, keyed by the runtime-owned `callId` (falling back to agent/label/slot/round), so a reader never meets the same agent twice. An agent whose `agent_end` never arrives is not collapsed and not dropped — its row reads `■ agent <name> started — no end recorded (evidence missing)`, because a missing end must never be folded into a green run. Replayed work carries its own marker, `↻ agent <name> replayed from run #<source>`, rather than a success glyph plus a suffix; the source run id is taken from the runtime's own resume metadata and is never parsed out of log text. When it is unavailable the row still declares the replay and says the source run is unknown. A continuation run opens with `↳ continues run #<source>` plus the operator's answer, so it is legible without its source run on screen. A run that stops at an operator gate renders that gate as its own block: a blank line, `◐ WAITING FOR OPERATOR — <title>`, the stage that was current and the tool that opened the gate, the questions, and the pending-answer line. The handoff envelope records no asking agent, so the block names the stage and never infers an agent from adjacency. Raw result/journal detail never enters the digest. Workflow agent lines use the stable catalog `agent` plus `label` and status, not the workflow parent-row petname: the live panel may collapse that parent in favour of an SDK child with a different canonical petname. Terminal markers are status-aware: `✓ … finished` only for `completed`, `◐ … awaiting operator` for a successful handoff, `⊘ … cancelled` for `cancelled`, and `✗ … failed` for `failed`. Agent-row markers are `✓ finished`, `⊘ cancelled`, `✗ failed`/`blocked`, `↻ replayed`, `■ ended (<status>)`, and `■ … no end recorded`. Journal `error` lines are not persisted separately: a failed run always emits exactly one final failure with `eventKind: "workflow_end"`, using the journal text only as a fallback when the final result has none. On the command path, evidence warnings and failures to persist the completion messages remain correctly levelled `warning` notifications. A `result.json` write failure already belongs to the final live/typed result and is not repeated as a toast. If `waitForIdle`, the final idle check, or `sendMessage` is unavailable or fails, completion persistence stops and a clear warning is shown; the persisted journal/result artifacts remain source truth. The fallback never calls `sendMessage` and therefore cannot steer the parent agent.

The compact workflow panel fits to the terminal height, keeps its journal internally, and shows the workflow/run header, the declared/reached/current stage frontier, the run's agent roster, bounded diagnostics, and the `/ps` inspection hint. The roster is the whole run in the order it happened: settled agents keep their status marker, duration, and token counter; the agent working right now keeps its spinner, its `warning` color, and its activity sub-line; and every declared stage the run has not reached yet follows as a dim `○ <title> · planned · <detail>` row, with the detail read statically from `meta.phases`. An undeclared dynamic stage appears only once it actually runs, so the roster never advertises work no declaration promised. A loop that re-enters a slot updates that one row and shows its `r<N>` round badge instead of appending a duplicate. When the roster does not fit the terminal, the oldest settled rows collapse behind an announced `(+N earlier agents)` line — the current row, the pending stages, and the final verdict are never the part that is dropped. It does not publish or expand the global fleet selection. Every `agent_end` status is terminal in the projection: `completed`, `failed`, and `cancelled` all leave `active`, atomically clear `currentTools`, `currentToolArgs`, and `currentToolStartMs`, freeze `elapsedMs`, stop the spinner, and render their own marker. Drill therefore cannot retain a stale command such as `sleep 60`, and duration cannot keep growing after cancel. Live-row settlement alone does not decide the workflow outcome: a bare result remains script-controlled, while a result returned directly from a `parallel()` branch or `pipeline()` stage with `status: "failed" | "blocked" | "cancelled"` becomes typed group failure after the barrier. Those rows participate in the shared fleet, but bare `Up`/`Down` always remain Pi editor/history input; `/ps` opens fleet management and `Shift+Down` is the registered fallback. Aggregate group rows remain visible status headings and are never selectable or actionable; in focused mode, `Enter`, `/ps last`, and direct targets operate only on exact leaf rows. Workflow leaf rows are inspectable but never keyboard-stoppable. `x` asks for confirmation only for a selected standalone working SDK child through its live `AbortController` seam. Terminal rows keep drill/back but expose no `x stop` affordance.

`dsl.log()` records `source: "script"` and appears in the live panel as
`│ script · <message>`. Internal workflow enter/exit and resume metadata record
`source: "runtime"`; old journal lines without `source` remain neutral journal
messages and are never relabeled as script output. The completion line prefers a
non-empty `result.summary`, then a scalar `result.verdict`, then a string result;
otherwise it reports `completed`. Arbitrary result objects are not guessed or
dumped into the live panel, tool text, RPC, or headless command output. Full
result JSON and `runDir` remain available through `/workflows status <runId>`
and `result.json`; the tool result exposes the semantic completion, bounded
lifecycle digest, artifact path, and persistence status.

The owned `[agent] ->` / `[agent] <-` transport markers are intentionally absent
from the main status surface because the structured fleet already shows those
transitions. `/workflows status <runId>` retains the markers in its detail
timeline. Failures and evidence warnings are not suppressed: failures remain in
main status and the final command event or tool digest; command warnings remain
correctly leveled `warning` notifications.

The runtime normalizes every script result through one JSON boundary. `null`
stays a valid successful result. A top-level `undefined`, `BigInt`, circular
value, or throwing `toJSON` becomes an explicit
`WORKFLOW_RESULT_NOT_JSON_SAFE` sentinel and makes the persisted outer envelope
`ok:false`; no surface may call that run completed. The final `result.json` is
mandatory evidence: an envelope/filesystem write failure also makes the returned
run `ok:false`, preserves the typed `resultPersistence` reason, and records a
runtime `error` journal line so `/workflows status` remains failed without a valid
result artifact. After this detach boundary, a JSON-safe top-level result with
boolean `ok:false` or `partial:true` is semantic non-success. Either condition
sets the returned and persisted run envelope to `ok:false`; status, command/tool
completion, `result.json`, and read-side status therefore cannot present the run
as success. A deliberate `partial:true` recovery may omit an `error` string.
Missing `ok`, nested `ok`, and non-boolean `ok` values retain legacy
execution-success semantics. For a semantic failure without a technical error,
the shared result owner formats the non-empty `summary`, then stable sorted
`unresolvedRows`; the transcript, tool/command result block, and live progress
consume that one value. A technical error retains priority. The fallback
`Workflow execution failed.` is used only when neither source provides a useful
diagnostic.

A failed run that carries a technical error also persists a `failureDiagnostic`:
the failing stage (the last `phase()` the journal recorded), the owning script
path, the failing stage's answer artifact, the run journal, and one copyable
`repairRequest` sentence. Paths are project-relative when they live inside the
root. `origin` separates `script` — the trusted script or its prompts rejected
the run — from `runtime`, and only the wording depends on it. Nothing is guessed:
an unproven stage, script, or answer is omitted rather than invented. A
deliberate `{ ok: false }` or `partial: true` verdict is a domain result, not a
defect, and gets no diagnostic. `result.json`, `/workflows status <runId>`, the
tool result, and the persisted run message carry the whole diagnostic including
the repair request; the width-clamped live panel shows the pointer lines only,
because a truncated repair request cannot be copied.

The outer envelope also persists a runtime-owned `disposition`. Its terminal
states are `completed`, `awaiting_operator`, `cancelled`, and `failed`; `ok`
remains the compatibility/script-result boolean. `dsl.awaitOperator({ reason,
operatorHandoff? })` records one bounded run-local declaration and does not
modify the script's returned `result`; the last declaration wins. A reason-only
declaration remains readable but is not directly actionable.
`operatorHandoff` declares a title, one or more bounded select/text questions,
and exact continuation artifact refs owned by the current run. The runner
supplies the version, stable handoff id, origin, and verified
self-contained-static target/script identity. At finalization, controlling
signal cancellation wins over failure, failure wins over a handoff declaration,
and a successful undeclared run is completed. Readers preserve the old
`ok -> completed|failed` behavior only when `disposition` is absent. A present
malformed or future disposition is `unknown`, never green.

Direct continuation re-reads the source envelope, verifies every declared
artifact and the unchanged target/script identity, then atomically claims the
handoff before using the ordinary background workflow launcher. The claim is
bound to the child run and contains no raw answer. Launch failure releases it;
a failed/cancelled child makes the source retryable, while a completed or newly
waiting child resolves the source item. `result.json` is never rewritten.
`--resume` remains recorded-call replay and is not a continuation alias.

The progress panel is allocated at run start, so a workflow that emits no journal
events still uses the same semantic completion grammar in TUI, RPC, and no-UI modes.

Workflow `agent()` steps still create source-backed workflow parent rows and pass `live.parentRowId` to SDK child sessions, but the live renderer collapses a workflow parent row once its real SDK child row exists. The visible running view therefore avoids duplicate `Working` lines such as `quick_task (label)` plus child `label`; it shows the group row, then the actual child agent row (`agent[model /effort=level] on task "label"`) and a compact current-task line with the task label plus active tool/args when available. The final summary appears in place, so the live view is never replaced by a truncated text widget.

The row renderer is the shared local `AgentLivePanel` (`extensions/_shared/agent-runtime/agent-live-panel.ts`),
not copied `pi-subagents` UI code. It renders source-backed optional fields only:
concrete runtime model plus `/effort` thinking level, activity state, current tools,
bounded current-task args, `steps=<n>(events)`, `turns=<n>(model turns)`, token counts,
child session id after SDK creation, result artifact, final answer, flags with inline meaning
such as `no-mcp(no MCP tools)`, errors, and elapsed time. `parallel()` and `pipeline()` also emit local
`group_start` / `group_end` journal lines so the panel can show bounded group
summaries such as completed/failed counts while preserving individual agent rows.

The live store is process-shared through a versioned `globalThis` symbol. This is
required by Pi's real extension loader: each package entrypoint is evaluated by a
fresh `jiti` instance with `moduleCache:false`, so an ordinary module singleton
would split workflow progress from `/agent drill` and fleet control.

`/workflows list [query]` is a read model over the same first-wins resolver used
by `/workflows run`: scan-based discovery for Project, User, and Package alike.
It does not add a separate UI-only registry. Every current row is one selectable
two-line block whose row identity leads with the workflow name and a compact
source badge (`[P]`, `[U]`, or `[PKG]`); its detail line carries the one-line
description and exact origin path. A path that still exceeds the terminal width
is middle-truncated so its beginning and basename remain visible. Current and
History stay adjacent when the terminal has spare rows; unused height remains
below the lists instead of splitting them. Very low terminals use a compact
one-line fallback.
History rows are separate evidenced runs, not a deduplicated list of names: each
row leads with the workflow name, then its `runId`, then the compact source
badge, and carries the persisted target, source label, and retained snapshot
availability. `[R]` means run history; `[P]`, `[U]`, and `[PKG]` are compact source
badges, not alternative registries.

In an interactive Pi TUI with custom UI support, Up/Down moves across every
selectable current or history row and Enter opens the exact selected source in an
`Inspect` viewer. Current selections are revalidated through the same resolver.
A deleted target, unreadable file, or new higher-precedence shadow produces an
explicit state and never switches paths. A valid current source is read in full
as inert UTF-8 text: it is not imported or executed.

History inspection reads only the immutable source snapshot recorded for that
exact run. A snapshot becomes `ready` only when all persisted identity checks
agree: a simple `runId`; the expected lexical run directory; a non-symlink
directory chain; exact `script-<sha256>.workflow.mjs` basename; a regular,
non-symlink file; physical containment as a direct child of that run directory;
readable bytes; a valid persisted target; and a matching content SHA-256. The
other states are explicit: `legacy`, `missing`, `unreadable`, `invalid`, and
`tampered`. After catalog selection, the browser re-reads the snapshot and
compares its run target, path, SHA, and identity coverage. A changed identity is
reported as `stale`; nothing opens until the operator returns and refreshes the
catalog. No persisted or browser state reads the current workflow or another
path as fallback.

The focused browser uses the available terminal height after reserving Pi's three
footer/status rows; it has no fixed 24-row ceiling. Pi's native
`highlightCode(..., "javascript")` provides syntax colors. A persistent `Code`
top border and a bottom border carrying the visible line range separate source
from identity metadata while scrolling. Up/Down, PageUp/PageDown, Home, and End
reach the final source line. `Esc` or the `Back` action returns to the preserved
catalog cursor. This internal viewer is a workflow-source alternative to printing
a long file; it does not change Pi's generic `Ctrl-O`, `cat`, or terminal-scrollback
behavior.

Press `i` on the source screen to open a dedicated identity screen. Its scroll is
independent from source scroll, and Up/Down, PageUp/PageDown, Home, and End keep
the full identity reachable even at terminal widths 8 and 1. Current identity
shows the human source label and exact path. History identity also shows the run
ID, exact snapshot path, and SHA when present. Press `i` again or `Esc` to return
to the source at the preserved position.

The action bar is deliberate prompt handoff, not execution. `Tab` or the
Left/Right arrows changes the focused action, and Enter activates only that
action. Focus is marked by
both a `›` caret and the theme's warning color (normally yellow); other available
actions use the success color (normally green). `[VIEW]`, `Source:`, `Path:`, and
the equivalent history metadata labels use the same semantic success styling so
metadata stays distinct from highlighted code:

- A ready current source offers `Back`, `Start`, `Edit`, and `Review`.
- A history source offers `Back` and `Review`; it never offers `Start` or `Edit`.
- A failed current read offers only `Back`. An unavailable or `stale` history
  snapshot keeps `Review` only when the prompt identifies the run and names the
  snapshot state; it never substitutes current source.

`Back` and cancellation return no intent. `Start`, `Edit`, and `Review` return a
typed intent from the custom component. The `/workflows` command awaits the
shared inline `ctx.ui.custom(..., { overlay:false })` surface, restores Pi's main
editor, and only then calls `setEditorText()` once. `Start` prefills the direct
`/workflows run <resolved-name>` command; submitting it reaches the runtime
without a model planning or authoring turn, and optional semantic input can be
appended on the same command line. `Edit` and `Review` still prefill the compact
`Request: ...`, `Agent: workflow-author`, and
`Additional instructions:` handoff because those actions require source work.
The named agent is the bundled `.agents/agents/workflow-author.md` catalog agent
shipped with this package, so the handoff points at a surface that exists after
`pi install`; it is reachable as `/agent run workflow-author` or
`task { agent: "workflow-author" }`.
Historical review keeps the exact run/snapshot identity. The browser itself does
not submit editor text, import a module, write a file, mutate history, send a
message, or claim success if the editor setter is missing or fails.

RPC, print/no-UI, and TUI hosts without custom UI keep an honest passive
projection. Empty, no-match, history-only, unavailable-source, and narrow-terminal
states have no phantom selection, and every rendered row is bounded to the
terminal width. Exact source identity remains discoverable through `i`, including
at the narrowest supported widths. The optional query is case-insensitive and
matches name or description; a miss names the query and reports the non-empty
catalog size instead of pretending the resolver is empty.

Metadata comes from a bounded inert AST scan of the first 64 KiB. Only a top-level
literal `export const meta = {...}` is considered; unquoted or quoted literal
`description` keys with static string values are accepted. Comments, unrelated
objects, computed keys, interpolation, imports, and runtime values are ignored.
The scanner never executes the module and reports unavailable/non-static metadata
explicitly.

`/workflows info [name]` builds one immutable `OperatorBlock` as its semantic
source. Bare `info` explains the commands, exact source precedence, static
metadata boundary, trusted-code limit, history, DSL primitives, catalog-agent
selection, model-role metadata, and actual model routing. Named `info` uses the
same first-wins resolver and adds the exact human source/path plus statically
parsed `meta.description` and, when the workflow declares them, its
`meta.phases`; an unknown name fails explicitly.

In an interactive Pi TUI with custom UI support, the command opens that complete
block in a workflow-owned read-only scroll view. Up/Down moves one line,
PgUp/PgDn moves one page, Home/End jumps to the first/final page, and Esc/q
closes the view. Tests reconstruct every rendered semantic line at
146, 80, and 48 columns. RPC, print/no-UI, and TUI hosts without custom UI keep
the same bounded passive projection; the TUI fallback says that interactive
scrolling is unavailable. Neither projection imports or runs a workflow,
invents an execution graph, mutates the editor, or writes a file. This focused
view is not a generic fix for `Ctrl-O`, `cat`, or terminal scrollback.

Bare `/workflows` opens the canonical command menu in TUI, including when an
actionable handoff is pending. Choosing `continue` from that menu (or typing
`/workflows continue <runId>`) opens the oldest handoff. In RPC and headless
hosts, the same command returns the typed `VIEW` help fallback. It clears stale
workflow chrome before installing the menu. Passive `/workflows list`,
`/workflows status`, settled run receipts, and non-interactive `/workflows info`
reuse the shared operator frame. Interactive list and info views are separate
workflow-owned custom components; info still renders the same semantic block as
its passive projection. Neither path replaces the domain-owned live progress
panel. Run discovery accepts only
directories with `journal.ndjson` or `result.json` and a provable start time.
Canonical ids use their UTC prefix; legacy ids use the first persisted journal
timestamp. Worktree-only/test-artifact directories are ignored instead of
appearing as `unknown` runs. TUI `/workflows status` shows the newest 10 accepted
runs and detail shows the newest 20 journal rows. RPC passive output uses a
host-budgeted four-run list and one newest detail event; both variants keep
literal total/shown/older or `+N hidden` and point to `result.json` for complete
evidence. Detail reverses chronological order and distinguishes script, runtime,
and legacy journal provenance. Missing runs and failed launches use typed
`ERROR`; busy/unprovable idle and invalid input use typed `WARN`; a headless
settled run uses `RESULT` or `ERROR`. TUI uses a width/height-aware component,
RPC uses plain `string[]`, and explicit no-UI hosts receive no fake widget
delivery.

Static passive workflow `VIEW` closes with `Esc` from the ordinary editor. This
removes only the last passive help/status/fallback view; active workflow `LIVE`
stays pinned until terminal state, and persistent/shared status is not cleared.
Escape inside an operator question is an answer, not a dismissal: the run
continues with a plain-text refusal naming its questions, keeping any answers
typed before it. It does not abort an agent or cancel a workflow —
`/workflows stop` remains the only cancellation path; flat `/workflow-stop` is
its compatibility alias.
The focused catalog owns the source-to-catalog and catalog-to-close lifecycle
described above. The shared TUI adapter requests a full host redraw for passive
open/close, so stale border or bracket glyphs do not remain after
open/close/resize.

### `workflow` tool (programmatic)

The tool stays headless. It validates the launch target and executes the workflow without
opening a human launch prompt.

```json
{ "name": "live-smoke", "input": "hello" }
```

The tool's `input` is the same optional semantic string as `/workflows run`,
bounded at 16000 characters and preserved unchanged. Cross-run state is a
separate closed `continuation` control with one origin and 1–8 complete artifact
refs. `continuation` and replay-only `resumeFromRunId` are mutually exclusive.

Legacy compatibility still accepts `script`, but it only maps to saved names or
project-relative paths.

---

## Run a real workflow (live)

The unit tests use a mocked host. To exercise the runtime for real, run `pi` with a
working model in a scratch project so child agents actually spawn:

1. Point a scratch dir at this package — `.test_pi/.pi/settings.json`:
   ```json
   { "packages": ["<absolute path to your locus-pi checkout>"] }
   ```
2. Drive the `workflow` tool from that dir. (Slash commands only render to the TUI, so
   for a non-interactive run ask the agent to call the tool.)
   ```
   cd .test_pi
   pi -p --approve --no-session --model "<provider/model>" \
     'Call the workflow tool with script="live-smoke" and input="hello".'
   ```
3. Verify it actually spawned child agents — don't trust the chat summary, read the journal:
   ```
   cat .test_pi/.pi/locus-pi/workflows/<runId>/runtime/result.json
   ```
   A real run shows `agent_end` events with `status: "completed"` and a non-empty
   `childSessions.*` session id. If the host cannot spawn a child, the run fails closed
   with the `Pi SDK host` reason (see "Fail-closed behavior") — an honest failure, not a proof.

Interactive `pi` (no `-p`) renders the live progress panel, and for
`workspaceMode: "worktree"` / `"temporary-worktree"` agents Pi native approval can
prompt for writes according to `tools.approvalMode` and `tools.approval.*`.
`locus-pi` no longer adds its own workflow launch gate before runtime starts.

### Local subagent chain proof

The project-local smoke workflow `.pi/workflows/local-test-append-smoke.workflow.mjs`
is not part of the curated Package registry, but it is the current repository proof
for the local subagent chain. It runs `local_file_worker` sequentially as Alpha,
Beta, and Gamma, forwards command text between steps, writes exactly three lines to
`.local/test.md`, and returns `ok:false` if any child result is not successful.

Fresh evidence:

- T-163 recorded Pi workflow run `20260628-000924-5deb`; `result.json`,
  `journal.ndjson`, and three child `agent-sdk-*.jsonl` reports prove the
  Alpha -> Beta -> Gamma chain completed.
- T-164 recorded an interactive tmux/Pi run `20260628-002237-798f` under
  `.locus/runtime/reports/tmux-qa-t164-20260628T002235Z/`. The final capture shows
  `workflow local-test-append-smoke (...) - OK  6/6` and nested parent/child rows
  for alpha, beta, and gamma without incoherent overlap.

---

## Authoring a new workflow

Authoring is approval-first. A raw request creates only
`.pi/workflows/<name>.design.md`: selected pattern, numbered algorithm, graph
table, node responsibilities, inputs, complete outputs, capabilities, consumers,
edges, concurrency, loop bounds, handoffs, mechanisms, and failure exits. Show it
to the operator and stop.

Only `Build approved design: <exact design path>` authorizes creation of the
matching `.workflow.mjs`. Build checks identity and module load but does not run.
If the algorithm changes materially, revise the design and ask for approval
again. The command approves the design bytes present at the path when Build
reads them; there is no separate approval token or persisted design digest, so
the operator reviews the current file immediately before issuing Build. The bundled `workflow-author` agent and
`skills/locus-pi-workflows/SKILL.md` own the exact protocol.

A workflow is a single ESM module `<name>.workflow.mjs` with two exports:

- `export const meta = { name, description, phases? }` — catalog metadata only.
  `name` should match the saved file's `<name>` so it resolves by bare name;
  `description` appears in `/workflows list` and `/workflows info <name>`;
  optional `phases` declares the pipeline's shape before the run (see "Declared
  phases" below). Metadata does not declare the execution graph, agents,
  permissions, or runtime model, and nothing in it is enforced at runtime.
- `export default async function runWorkflow(dsl, input) { ... }` — executable
  behavior. `dsl` is the intended authoring handle; `input` is the run's task,
  always absent or bounded semantic text (see "Workflow input" below). Whatever
  the function returns is written to `result.json` as `result`.
  Trusted JavaScript can still use host capabilities allowed by its identity mode,
  so `dsl`-only is a convention, not enforcement.

Destructure the primitives you need from the first arg:

```js
const {
  agent,
  publishArtifact,
  consumeTextArtifact,
  continuationArtifacts,
  awaitOperator,
  phase,
  log,
  parallel,
  pipeline,
  workflow,
  promptFile,
  workspace,
} = dsl;
```

The DSL is injected by Pi, so a workflow does not import runtime functions at
execution time. Repository-owned `.mjs` files can still give JavaScript IDEs a
declaration target with an import type in JSDoc:

```js
/**
 * @param {import("../runtime/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {string | undefined} input
 */
export default async function runWorkflow(dsl, input) {
  // PyCharm/WebStorm can now navigate agent(), phase(), log(), and other DSL methods.
}
```

Adjust the relative type path for a nested workflow. This comment performs no
runtime import and does not change source-identity coverage.

### Workflow diagram contract

A workflow with several stages, agents, branches, parallel groups, or persisted
handoffs keeps a visual map beside its source: exactly one hand-authored
`<name>-pipeline.svg`. It is edited directly. There is no generator, no
rendering dependency, and no exported preview to keep in sync;
[`extensions/workflows/examples/plan/plan-pipeline.svg`](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/plan/plan-pipeline.svg)
is the reference shape.

This replaced a generated trio — an `@kroffske/excalidraw-diagrams` generator,
its `.excalidraw` document, and a rendered PNG — on 2026-07-28. Three files had
to agree, changing anything required a library this package does not depend on,
and the only file a reader opened was the one nobody could review in a diff.

The diagram is an ownership map, not a decorative code trace:

- Separate the deterministic script from the child agents visually, and give the
  script one box per `phase()`. A reader must be able to see which decisions the
  code makes and which a model makes without opening the source.
- Every agent box says what it **receives** and what it **returns**. The handoffs
  between stages are the pipeline; a box that names only a role explains nothing.
- Say what constrains each child: its prompt, declared answer shape, and answer
  cap. Every child already receives all tools. A branch on a shaped answer is not the
  same claim as a branch on prose, and the picture must not blur them.
- Every branch and loop carries its real exit condition, including the ones that
  end the run: an operator pause with `disposition: awaiting_operator`, a
  fail-closed stop, and the terminal result a later run may consume.
- Draw each persisted artifact under the exact name the code publishes it with,
  so the picture and `.pi/locus-pi/workflows/<runId>/runtime/artifacts/` agree.
- Include a legend explaining every visual type used.

Keep the file self-contained and diffable: no `<script>`, no embedded or remote
images, no remote fonts or stylesheets, and a `<title>`/`<desc>` pair so the
diagram is readable without seeing it. `tests/extensions/workflows/workflow-diagram-artifacts.test.ts`
pins those properties, refuses any resurrected generator or Excalidraw artifact
under the examples directory, and checks the diagram against the workflow source
so a renamed phase or a new artifact fails the suite instead of quietly leaving
the picture wrong. Visual inspection is still required: no structural check
proves that a diagram is readable.

### Minimal working example

One real agent that does a tool action and returns text:

```js
// hello.workflow.mjs
export const meta = {
  name: "hello",
  description: "One agent lists the cwd and returns readable text.",
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const task = (typeof input === "string" && input.trim()) || "list the cwd";

  phase("work");
  const workerText = await agent(`Task: ${task}. Use a tool once, then return a concise Markdown answer.`, {
    agent: "quick_task",
    label: "work",
  });
  log("worker returned non-empty text");
  return workerText;
}
```

Notes:

- Keep `meta.description` as one concise, purpose-first sentence: name the useful
  outcome, not test evidence, implementation detail, or a long execution trace.
  Use a literal static string near the top of the module. The browser scans only
  the first 64 KiB, accepts no interpolation/computed value, and shortens catalog
  display after 96 characters. Project and user workflows are never rewritten by
  the browser.
- `agent()` returns the child's exact non-empty final text by default. It never
  exposes child status fields as a model-controlled result, and it parses
  JSON-looking text only when the call declared a `schema` — the opt-in shaped
  path below. Technical metadata is written to the workflow journal.
- Write a stage's prompt inline in the script by default: a shared `COMMON`
  contract constant plus a per-stage template literal that interpolates the
  previous stage's exact text between `--- BEGIN <NAME> ---` / `--- END <NAME> ---`
  markers. The whole workflow then reads in one pass, and the retained script
  snapshot covers the prompt bytes, so a prompt edit changes the script identity
  instead of altering behavior beneath an unchanged hash.
- Use `promptFile("./resources/name.prompt.md", variables)` for the two cases
  where a separate file earns its indirection: a role charter long enough that
  inlining it buries the routing (roughly 80 lines and up, like the curated
  `review` verifier), or a prompt genuinely shared by more than one workflow.
  Keep the stable role and the per-run task in that one prompt. The path is
  source-relative and hash-backed, and it must resolve to a packaged
  `*.prompt.md`. Workspace isolation remains visible in the `agent()` options;
  tool policy does not, because every workflow child receives `tools: ["*"]`.
- `agent()` is the only model-calling step. For a **cheap one-shot decision**
  (a gate or classification), use
  `agent(prompt, { choice: ["accept", "revise"] })`.
  Standard source does not wrap that call in a parser or validator.

### Declared phases — `meta.phases`

A run's shape is otherwise only knowable by executing it, because phases are
declared imperatively by `phase()` calls inside the body. Optional `meta.phases`
states the pipeline up front, and it is read by the same bounded catalog scan
that already extracts `description` — first 64 KiB, AST only, module never
imported or evaluated:

```js
export const meta = {
  name: "review",
  description: "Prepares clarification or runs a question-led review with runtime-owned artifacts.",
  phases: [
    { title: "prepare-clarification", detail: "Persist exact intent and prepare questions." },
    { title: "consume-clarification", detail: "Verify prior-run refs and persist answers." },
    { title: "resolve-scope", detail: "Turn exact intent and clarification into one review scope." },
    { title: "inventory-changes", detail: "Prove complete coverage of the changed surface." },
    { title: "plan-units", detail: "Group the inventory into atomic units of meaning." },
    { title: "ask-questions", detail: "Loop: write falsifiable questions, then assess whether a round is missing." },
    { title: "verify-review", detail: "Reopen evidence, answer questions, and author review.md." },
  ],
};
```

Rules:

- **Optional.** A workflow without `phases` is valid and every surface renders
  exactly as before. The curated `requirements-grill`, `review`, and `review-fix`
  declare theirs; single-stage `live-smoke` does not.
- **Literal only, all or nothing.** Each entry is an object literal with a
  non-empty static string `title` and an optional static string `detail`. One
  computed value, template interpolation, spread, or non-object element discards
  the entire declaration rather than reporting a partial pipeline — the same
  fail-closed rule an interpolated `description` already follows.
- **A declaration, not a contract.** Nothing validates `phases` at runtime.
  `/workflows status <runId>` matches declared titles against the `phase()` lines
  the run actually emitted: a declared phase that never ran shows as unreached,
  and a `phase()` with no declaration is appended as its own group marked
  `(undeclared)`. Neither fails a run — a `phase()` inside a branch may
  legitimately never execute.
- **Where it shows.** `/workflows info <name>` lists the declared stages with
  their details; `/workflows list` adds `phases=<count>` to the row; `detail` is
  shortened past 96 characters like `description`.

Titles should equal the `phase()` argument they describe, so the two stay
readable together. A curated workflow's declaration is regression-tested against
its own `phase()` calls for exactly that reason.

### Workflow input and host continuation

`input` is absent or one semantic string of at most 16000 characters, handed to
`runWorkflow(dsl, input)` unchanged by the tool and outer-trimmed only by the
slash-command parser. It contains the operator request or answers. It is not a
JSON command, marker grammar, or generic parameter bag. An object is rejected by
the tool schema and guarded again by the runner; nested `dsl.workflow()` calls
have the same string-only bound before their callback starts.

```json
{ "name": "audit-module", "input": "Audit src/auth strictly; report at most five confirmed findings." }
```

Agents interpret meaning. Trusted JavaScript owns orchestration, branches,
bounded loops, and deterministic invariants; workflow authors must not smuggle a
second object-input protocol into the string with JSON or marker parsing.

Cross-run state travels separately through the tool's closed `continuation`:

```json
{
  "name": "review",
  "input": "The migration is reversible; old clients remain supported.",
  "continuation": {
    "originRunId": "20260722-120000-abcd",
    "artifactRefs": [
      { "runId": "20260722-120000-abcd", "artifactId": "published-0001", "name": "intent.md", "sha256": "..." },
      {
        "runId": "20260722-120000-abcd",
        "artifactId": "published-0002",
        "name": "clarification-questions.md",
        "sha256": "..."
      }
    ]
  }
}
```

The control accepts exactly `originRunId` and 1–8 complete refs. Every ref must
belong to the origin; duplicate identities and unknown fields fail closed. The
runtime verifies digests and copies text before workflow code or a child starts,
then exposes readonly `{sourceRef, consumedArtifact}` pairs through
`dsl.continuationArtifacts()`. The first journal event is the canonical runtime
continuation binding with exact source and current-run consumed refs. Direct
slash continuation is not supported. `continuation` cannot be combined with
replay-only `resumeFromRunId`.

### What is NOT supported

- **No arbitrary inline JS through the `workflow` tool.** The tool is trusted-file
  only: a saved `name` or a project-relative `scriptPath` (`script` is a legacy alias
  that normalizes to one of those). To run ad-hoc logic, save a `.workflow.mjs` first.
- **No custom primitives / event kinds / lifecycle states.** The DSL surface below is
  the whole contract; do not invent a primitive the runtime does not expose.
- **Use `dsl` only as an authoring policy.** Reach the filesystem/model through
  `agent()` in reviewed workflows. This is not
  enforced: static Node builtins and explicit `entry-only` scripts retain full
  Node.js/module capabilities in the Pi host process. Do not run an unreviewed
  file or treat identity coverage, a worktree or an approval receipt as a
  security boundary.
- **No silent dependency downgrade.** Default scripts must stay one source module
  apart from static `node:` imports. If reviewed code genuinely needs local,
  package, dynamic or `import.meta` behavior, declare literal
  `meta.identityCoverage: "entry-only"` and treat its hash as entry-only evidence.

### Delegate authoring to the `workflow-author` agent

Delegate a plain requirement to `workflow-author` with `/agent run
workflow-author` or `task { agent: "workflow-author", task: "<requirement>" }`.
That first turn writes only the design. After the user approves it, send `Build
approved design: .pi/workflows/<name>.design.md`; only that turn writes source,
confirms identity and module load, and returns the path. Neither turn runs the
workflow. The helper is a catalog agent only; the package surface remains
`./extensions/workflows/index.ts`.

---

## DSL surface (v0)

```ts
agent(prompt, opts?)          // Run a catalog/local agent; returns exact child text
agent(prompt, {choice, …})    // Standard machine route; returns one declared exact string
agent(prompt, {handoffs, …})  // Standard dynamic decomposition; returns bounded text units
agent(prompt, {schema, …})    // Advanced compatibility; returns the validated shaped value
fusion(question, options)     // 2-10 isolated answers -> separate judge; returns only the judge answer
fusion(question, {schema, …}) // Same panel; validates only the judge's final answer
publishArtifact(name, text)   // Persist workflow-authored text; return full digest-bound reference
publishPrimaryArtifact(name, text) // Publish the run's one primary semantic document
consumeTextArtifact(ref)      // Verify/copy prior-run text; return current ref + exact text
awaitOperator({reason})       // Declare a successful operator handoff without changing result
promptFile(path, variables?)  // Render a neighboring .prompt.md resource
workspace(label, ref)         // Allocate one retained workspace; returns opaque handle
projectRoot()                 // Absolute launch project root
runWorkspaceDir()             // Absolute working directory for this run; agent file names kept verbatim
parallel(thunks)              // Full barrier; success returns ordered T[], ordinary failed branches reject typed evidence
pipeline(items, ...stages)    // Per-item staged chains; a failed item stops before its later stages, then typed reject
phase(name)                   // Progress grouping + journal line
log(msg)                      // Journal line
now()                         // Recorded wall clock (ms); replayed on --resume
random()                      // Recorded randomness in [0,1); replayed on --resume
```

`fusion()` defaults to prompt-only context and never reads ambient chat history.
Explicit `context: { mode: "provided", text }` is copied verbatim into the
Fusion packet artifact. Member answers default to 8,000 characters, the judge
answer to 16,000, and the complete judge prompt has a fixed 160,000-character
ceiling. All declared members are required; a member failure stops before the
judge runs. Larger panels may need a lower member answer bound because preflight
reserves the worst-case escaped candidate size. The production runner resolves
all declared model selectors before the first child, and overlapping Fusion
calls reserve their complete worst-case invocation counts atomically. A resume
tries recorded answers without requiring the old models to remain configured;
Fusion fails before any fresh child if one of its recorded legs is missing or
divergent. Run without `--resume` to execute a new panel.

`awaitOperator()` accepts exactly one non-empty compact reason of at most 200
characters. It is a control declaration, not model output and not a thrown
pause. Call it only after durable handoff artifacts exist, immediately before
returning the unchanged handoff payload. An abort or semantic/infrastructure
failure still wins at finalization.

If the operator answers the question, the workflow's continuation run receives
their answer text. If they press Escape, it receives a plain-text refusal
instead — the same questions, each with whatever was answered before the
refusal, under the line `The operator declined to answer this workflow's
questions.` — delivered through the same channel and the same continuation. It
is not a status and the runtime attaches no handling contract to it: what a
declined question means is the workflow author's decision, exactly as it would
be for any other answer text.

A question opens on its own only for a run the current Pi session started, or a
continuation that run spawned. Nothing an earlier session left unanswered
interrupts a new one — not at session start and not on its first settled turn.
Those questions stay in their run's evidence and reopen on request: the
`/workflows` menu's `continue` entry takes the oldest pending one project-wide,
and `/workflows continue <runId>` takes a named run.

`runWorkspaceDir()` is the absolute path of this run's working directory
(`.pi/locus-pi/workflows/<runId>/workspace/`), created before the script starts.
Every child agent's prompt opens by naming the same directory and telling it to
create the run's files there under their exact names. Nothing in the
runtime renames, numbers or moves what an agent writes, so a path a workflow
prints in a question is a path that exists. Auto-captured readable material goes
to `outputs/`; machine evidence and transcripts go to `runtime/artifacts/`.
See `docs/runtime/workflow-run-storage.md`.

`now()` and `random()` exist so a workflow can be nondeterministic AND replayable.
They return exactly what `Date.now()` / `Math.random()` would, and the runtime
records each value in the run's replay record; a resumed run reads the recorded
value instead of producing a new one. Calling `Date.now()` or `Math.random()`
directly is not forbidden — those values are simply unrecorded, and a script
containing them is refused for replay. See "Resume and replay".

### Group failure contract

`parallel()` and `pipeline()` are fail-closed full barriers. They let already
scheduled independent siblings settle before reporting the group outcome. If
every slot succeeds, both primitives preserve input order and return the same
success arrays as before; an explicitly fulfilled `null` is a valid value.

An ordinary branch or stage fails when it throws, or when its **direct return
value** is an object with `ok:false` or
`status: "failed" | "blocked" | "cancelled"`.
`pipeline()` stops later stages for that item while other items continue to the
barrier. After the barrier, either primitive rejects one
`WorkflowGroupFailureError` with stable `code: "WORKFLOW_GROUP_FAILURE"`,
`groupKind`, `groupId`, `total/completed/failed`, ordered `slots`, ordered
`partialResults`, and indexed `failures`. A pipeline failure also carries
`stageIndex`; a returned failure may carry its `status`.

Use `error.slots` as the unambiguous in-memory view. A fulfilled `null` is
`{ index, status: "completed", value: null }`; a thrown position is
`{ index, status: "failed", failure }` with no value. `partialResults` is only a
convenience view: thrown positions appear as `null`, while directly returned
failure records stay inspectable in their failed position.

`WorkflowInvocationCapError` is the deliberate exception to group capture. It
remains a separate hard run-level failure rather than becoming partial branch
evidence.

If the script does not catch this typed error, `runWorkflowScript` persists a
JSON-safe `WorkflowGroupFailureEnvelope` as `result`. It contains counts, slot
status, and failure metadata but omits potentially non-JSON-safe branch values;
both the inner failure envelope and the outer run have `ok:false`. The failed
`group_end` line records the actual completed/failed counts, and no tool,
command, live, status, or `result.json` surface may project the run as success.

Partial continuation is an explicit author decision, not the default. Catch only
the stable code, rethrow every other error, inspect `slots`/`partialResults` in
memory, and return a JSON-safe top-level result with `partial:true`:

```js
try {
  const results = await parallel(thunks);
  return { ok: true, results };
} catch (error) {
  if (!error || error.code !== "WORKFLOW_GROUP_FAILURE") throw error;
  return {
    ok: false,
    partial: true,
    completed: error.completed,
    failed: error.failed,
    failures: error.failures,
  };
}
```

The runner treats `partial:true` as non-success even if `ok:false` is omitted.
Workflow scripts are trusted JavaScript, so the runtime cannot forbid a broad
catch; the typed check and explicit partial marker are the supported authoring
contract, not an enforcement or security boundary.

`opts` for `agent()`:

| Field             | Type                                   | Default                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`           | string                                 | `"default"`                           | Catalog name from `.agents/agents/`; pass `"quick_task"` explicitly for the mechanical worker path                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maxToolCalls`    | positive safe integer                  | budget `toolCalls` (`1000`)           | Per-child-attempt runaway safety fuse. Do not set it to zero. The first over-budget tool start aborts the child; this is not a normal work target or security boundary.                                                                                                                                                                                                                                                                                                                                             |
| `timeoutMs`       | integer 1..2147383628                  | budget `timeoutMs` (`600000`)         | Wall-clock fuse for one child attempt. On expiry the runtime **aborts the child** and the call fails closed; it never resolves to a partial answer. `maxToolCalls` cannot end a stalled child. The upper bound reserves room for the SDK backstop at 20 turns while keeping both delays within Node's real timer range; larger delays would be clamped to roughly 1 ms.                                                                                                                                             |
| `maxTurns`        | integer 1..20                          | budget `turns` (`5`)                  | Assistant turns for one child attempt. A value outside the host clamp is refused before any child starts. It was a hidden constant that multiplied the child's whole wall clock; it is now a declared budget axis.                                                                                                                                                                                                                                                                                                  |
| `maxAnswerChars`  | positive safe integer                  | budget `answerChars` (`500000`)       | Upper bound on the child's answer. An oversized handoff breaks the next stage's prompt, so the call fails here instead of downstream. Enforced on replayed answers too.                                                                                                                                                                                                                                                                                                                                             |
| `attempts`        | safe integer 1–3                       | `1`                                   | Physical child attempts for this one call when the **transport** failed — the child never got to answer, or lost the channel while answering. Refused, never clamped, outside 1–3. Never re-asks an answer the child did produce.                                                                                                                                                                                                                                                                                   |
| `label`           | string                                 | —                                     | Journal / UI label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `artifact`        | string                                 | safe label or agent name              | Logical name for the exact automatic answer artifact. It must be a safe single component; transcript/result names derive from it.                                                                                                                                                                                                                                                                                                                                                                                   |
| `phase`           | string                                 | current phase                         | Overrides the active phase tag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workspaceMode`   | string                                 | `"project"`                           | Workspace intent: `"project"`, `"worktree"`, or `"temporary-worktree"`. Worktree modes allocate an isolated git worktree for file-change review UX.                                                                                                                                                                                                                                                                                                                                                                 |
| `workspaceHandle` | string                                 | —                                     | Opaque handle returned by `workspace(label, ref)`; reuses one runtime-owned linked worktree across agent calls.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sandbox`         | string                                 | —                                     | Deprecated workspace alias. `"read-only"` maps to `workspaceMode: "project"`; `"workspace-write"` maps to `workspaceMode: "worktree"`. Explicit `workspaceMode` wins. It does not restrict tools.                                                                                                                                                                                                                                                                                                                   |
| `model`           | string                                 | the resolved tier, else session model | Per-call CONCRETE selector `provider/id` with an optional `:off\|minimal\|low\|medium\|high\|xhigh` child reasoning-effort suffix. The resolved model and requested effort are passed to the child session. A selector this host's registry cannot resolve **fails the call** by name, with no child spawned — it never falls back to `ctx.model`.                                                                                                                                                                  |
| `modelRole`       | string                                 | the resolved tier, else session model | Per-call TIER: a name in the roles table (`smol`, `slow`, `task`, …), never a provider selector. The package ships no assignments, so an operator layer has to say what the name means; a role nothing assigns degrades to `ctx.model` and records `modelRoleFallback` on `agent_end`, in the run-result artifact and in the run report. A role that IS assigned but whose value is not a parseable selector is a config error, not an unassigned role: it fails the call by name, quoting the value and the layer. |
| `choice`          | string[] (2–32 unique values)          | none                                  | **Standard machine-routing form.** Desugars to a string-enum schema before request canonicalization, so repair, replay, journal evidence, budgets, and fail-closed exhaustion are identical to the existing shape path. Cannot be combined with `schema` or `validate`.                                                                                                                                                                                                                                             |
| `handoffs`        | `{minItems?, maxItems, maxItemChars?}` | none                                  | **Standard dynamic-decomposition form.** Returns 0–100 complete non-blank text units with author-declared bounds; defaults to `minItems: 0` and `maxItemChars: 8000`, with a 32000-character ceiling. Desugars to the existing unique trimmed string-array schema path, so runtime owns repair, replay, evidence, budgets, and fail-closed exhaustion. Cannot be combined with `choice`, `schema`, or `validate`.                                                                                                   |
| `schema`          | object (JSON Schema)                   | none                                  | **Advanced compatibility.** Declare an arbitrary answer shape: the call returns the validated value instead of text, retries up to `SCHEMA_MAX_ATTEMPTS`, and throws `SchemaValidationError` on exhaustion. Standard generated source uses `choice` instead.                                                                                                                                                                                                                                                        |
| `validate`        | `(value) => string[]`                  | none                                  | **Advanced compatibility, requires `schema`.** Cross-field rules the subset cannot declare. Runs only on a schema-valid parsed value; a non-empty return re-asks the child in its own labelled block. Standard generated source does not emit validators.                                                                                                                                                                                                                                                           |

`agent()` resolves to exact non-empty text. The runtime persists that text before
emitting terminal `agent_end`; fresh sessions also contribute their transcript
and result envelope. Child metadata and diagnostics stay in journal/result
evidence; model text is never parsed as status or JSON unless the call opted into
runtime-owned `choice`/`handoffs` or advanced `schema`.

An assistant turn that ends with provider `stopReason=length` is not exact text:
the provider stopped at its output-token limit. The host therefore fails that
agent call as `provider-error` and preserves the transcript evidence instead of
publishing the partial answer or passing it to the next workflow stage.

Every default above comes from ONE object — `DEFAULT_WORKFLOW_BUDGET` in
`extensions/workflows/runtime/workflow-budget.ts` — which the runner applies to every run.
An explicit per-call value always wins: below the default it applies silently,
above it the runtime writes a journal line naming the axis, the default and the
requested value. There is no small authoring ceiling such as the former 100-call cap.
See "Run budget" for the run-level axes and for what the report shows.

**Replay policy for the bounds.** `timeoutMs` and `maxTurns` are part of the
canonical request, exactly like `maxToolCalls`: they shape execution, so changing
one makes a different call and the earlier record is not reused. Because
`timeoutMs` and `maxTurns` gained package defaults, records written before those
defaults existed are no longer replayed — reusing them would serve text produced
by an unbounded child as if a fuse had been in force. `maxAnswerChars` is
deliberately _not_ part of the request — it is a runtime gate applied to whatever
answer arrives, fresh or replayed, so an old recording stays replayable and a
tightened bound fails the run loudly instead of passing text the next stage
cannot hold.

`attempts` follows `maxAnswerChars`, not `timeoutMs`: it never joins the canonical
request, so a recording written before the option existed still replays, and a call
that adds a retry budget keeps the key it already had. The retry itself is invisible
to replay by construction — the replay envelope opens once per **logical** `agent()`
call, and every physical attempt inside it shares that one ordinal. Recording a
discarded attempt at its own ordinal would shift every later call on `--resume`, trip
the one-way divergence latch, and re-run the recorded suffix live.

### The two retries, and which failure each one owns

The runtime has exactly two retry loops, and they answer different questions. Neither
re-asks a child because its prose was thin: when an answer needs judging, the answer is
another agent whose job is that judgement.

| Loop                             | Question it answers                                             | Declared by                                    | Bound                                     | On exhaustion                                   |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| **Value repair** (pre-existing)  | "The child answered — is the answer the declared choice/shape?" | `choice`, or advanced `schema` plus `validate` | 2 attempts, 3 when `validate` is declared | `SchemaValidationError`                         |
| **Transport retry** (`attempts`) | "Did the child get to answer at all?"                           | `attempts`                                     | the declared 1–3                          | the call fails closed with the last cause named |

The value repair is described under [exact choice](#standard-exact-choice--agent-choice)
and [advanced shaped answers](#advanced-compatibility-shaped-answers--agent-schema)
below. It re-sends a **different** prompt — the previous validator errors
come back to the child in a labelled repair block — so each of its attempts is its own
logical call with its own replay ordinal. The transport retry re-sends the **identical**
prompt, because there is nothing to repair: the child never answered.

The two multiply rather than add. A shaped call declaring `validate` and `attempts: 2`
can run up to `2 x 3 = 6` children, and every one of them is charged to
`maxTotalAgentInvocations` and writes its own transcript and result envelope. A transport
budget exhausted inside a shape attempt ends the run there rather than handing the shape
loop a rejected answer — there is no answer to reject.

**Which failures the transport retry owns.** An allowlist of two named causes, not
"everything the never-retry list forgot":

| Cause                                                                      | Retried | Why                                                                                                   |
| -------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `host-turn-timeout`                                                        | yes     | the host's turn budget expired and the child was aborted                                              |
| `call-timeout`                                                             | yes     | the call's own `timeoutMs` fuse expired and the child was aborted                                     |
| `sdk-unavailable`                                                          | no      | there is no channel to re-ask on                                                                      |
| `cancelled`                                                                | no      | re-asking would override the operator                                                                 |
| `tool-call-budget`                                                         | no      | a fuse that re-arms is not a fuse                                                                     |
| `provider-error`                                                           | no      | provider-side, not a lost channel; classified, never guessed at                                       |
| `unparseable-answer`, `empty-answer`, `answer-too-long`, `script-rejected` | no      | the child **answered**; an empty or oversized answer is a decomposition signal, not a dropped channel |
| `unknown-agent`, `workspace-allocation`, `run-policy-blocked`              | no      | author or environment errors a retry would hide                                                       |
| `unclassified`                                                             | no      | nothing has shown this cause to be transient                                                          |

The cause is a machine-readable field on `agent_end`, set where each cause is known and
carried unchanged through the host, the run envelope and the bridge — and on the terminal
`error` line for `sdk-unavailable`, which never reaches an `agent_end` because it throws.
A result written
before the field existed reads as `unclassified` and never retries. Promoting a cause out
of `unclassified` is its own evidenced change, never a widening of the default.

**Which calls may declare it.** Ordinary project-workspace calls may declare
`attempts > 1`; every attempt receives the same full tool set. Calls bound to a
runtime worktree or `workspaceHandle` are refused because a later attempt would
inherit filesystem state from the earlier attempt. Nothing silently downgrades
the requested count.

**What the evidence shows.** Every physical attempt is a real agent call: its own `callId`,
its own `agent_start` and its own terminal record — an `agent_end`, or an `error` line when
the attempt **threw** instead of answering — both carrying `attempt`, `attempts` and the
`logicalCallId` of the one call they belong to, its own transcript
and result directories, and its own charge against `maxTotalAgentInvocations`. A
`[workflow:retry]` line names the boundary between attempts, and the run's journal folder
`.pi/locus-pi/workflows/<runId>/outputs/README.md` grows a `## Retried agent calls` section listing every attempt by
`callId` with the discarded one's cause; an attempt that threw is listed as `threw`. That
section reads both terminal kinds on purpose: a call that timed out, was re-run and then
threw leaves exactly one `agent_end` behind, and a report built from `agent_end` alone
would show a stage that ran twice and was billed twice as if it had never retried. A budget
blind to its own retries is a gate that does not count what it gates.

The per-call result envelope carries `failureCause` as well, so a reader who has only the
persisted `locus.agent.run-result.v1` body still gets the machine-readable cause rather than
the reason sentence. Where the workflow's own `timeoutMs` fuse ended the call, that is the
cause written into the envelope: the host reports the cancellation it observed, which is
true and is not the whole truth, and the caller that fired the fuse hands its classification
down before the envelope is written so the two most durable records of one call agree.

`logicalCallId` is what that section groups by, and it is not decoration: `parallel()`
can run two calls that agree on agent, label, phase and group, and their attempts then
interleave in the journal. A reader grouping by those descriptive fields would put one
call's discarded attempt under the other — a section that reads as evidence while being
wrong. The three fields travel together and the journal reader refuses a line carrying
one without the others.

**When the transport failure never becomes a result.** One cause cannot be retried and
cannot be reported as a failed call either: if the agent SDK substrate is unavailable
there is no channel to re-ask on, so the call **throws** and the run ends. There is no
`agent_end` for it. The terminal journal record is the `error` line, which carries
`failureCause: "sdk-unavailable"` for exactly that reason — so a reader never has to
tell that case apart from any other by reading the message text. The same line carries the
attempt trio whenever the call declared a budget, so an attempt already spent stays visible
even when the next one ends the run. The bridge decides to throw on that typed cause and
never on the diagnostic prose beside it.

### Standard exact choice — `agent({ choice })`

Use `choice` when workflow JavaScript must select one small branch:

```js
const route = await agent("Choose the next step.", {
  choice: ["accept", "revise", "blocked"],
});
```

The declaration contains 2–32 unique, non-empty strings, each at most 200
characters. It cannot be combined with `schema` or `validate`. The runtime
desugars it to `{ type: "string", enum: [...] }` before canonicalizing the
request. The equivalent hand-written schema therefore produces the same prompt,
replay key, journal evidence, repair bound, and fail-closed error. Standard
generated workflows use this form for machine routing and exact text for every
narrative result.

### Standard dynamic decomposition — `agent({ handoffs })`

Use `handoffs` when a discovery agent must define bounded runtime work units for
visible downstream workers:

```js
const dags = await agent("Return one complete text handoff per DAG.", {
  handoffs: { minItems: 1, maxItems: 64, maxItemChars: 4000 },
});

const descriptions = await parallel(
  dags.map((dag, index) => () => agent(`Describe this exact DAG:\n${dag}`, { label: `describe-${index + 1}` })),
);
```

The declaration requires `maxItems` from 1–100. `minItems` defaults to 0 and
cannot exceed `maxItems`; `maxItemChars` defaults to 8000 and is capped at 32000. Runtime requires every returned member to be non-blank and unique after
trimming, then desugars the declaration to the equivalent array schema before
request canonicalization. Its prompt, repair attempts, replay key, journal
evidence, budget accounting, and fail-closed error are therefore identical to
that existing path. Workflow JavaScript receives `string[]`; it does not parse
model prose or own a domain schema.

`handoffs` enables dynamic fan-out but not recursive manager delegation. SDK
children still cannot call `spawn_agent` or `task`; the approved source must
show the downstream `parallel()`/`pipeline()` calls and their capabilities.

### Advanced compatibility: shaped answers — `agent({ schema })`

This is the **value** half of [the two retries](#the-two-retries-and-which-failure-each-one-owns)
above: the repair loop for a child that answered off-shape. The transport half
(`attempts`) never reaches this code, and this loop never re-asks a child that failed
to answer.

The exact-text default is the contract for narrative results, `choice` is the
standard branch form, and `handoffs` is the standard bounded dynamic-list form.
Raw `schema` remains for reviewed compatibility scripts that genuinely need a
larger machine value:

```js
const gate = await agent(await promptFile("resources/gate.prompt.md", { diff }), {
  agent: "reviewer",
  label: "gate",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      reason: { type: "string" },
    },
  },
});
if (gate.verdict === "fail") return { ok: false, summary: gate.reason };
```

What the runtime does, in order:

1. Recursively validates the declaration before any child starts. The only
   supported keywords are `type`, `enum`, `required`, `properties`,
   `additionalProperties:false`, `items`, the string bounds `minLength`,
   `maxLength`, `pattern`, and `nonBlank`, and the array bounds `minItems`,
   `maxItems`, `uniqueItems`, `uniqueTrimmedItems`, and `uniqueBy`;
   the only supported types are `object`, `array`, `string`, `number`,
   `integer`, and `boolean`. Unsupported types/keywords and malformed or
   misplaced declarations fail with zero child calls, as do a bound on the wrong
   type, a negative or non-integer bound, an unsatisfiable `min > max` pair, and
   a `pattern` that does not compile — an impossible contract must not burn every
   retry and then surface as an unexplained exhaustion. `pattern` follows the
   JSON Schema spec: an unanchored ECMA-262 search with no flags, so a schema
   that means the whole value writes `^`/`$` itself.

   The uniqueness and blankness keywords carry their own placement rules, all
   refused before the first child call:

   | Keyword                    | Where             | Requires                                                                                                                            |
   | -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
   | `nonBlank: true`           | a `string` schema | literally `true`                                                                                                                    |
   | `uniqueItems: true`        | an `array` schema | `items.type` is `string`, `number`, `integer`, or `boolean` — use `uniqueBy` for objects                                            |
   | `uniqueTrimmedItems: true` | an `array` schema | `items.type` is `string`; cannot be declared beside `uniqueItems`, which it already implies                                         |
   | `uniqueBy: "<property>"`   | an `array` schema | `items.type` is `object`, and the property is in `items.properties`, listed in `items.required`, and declared with a primitive type |

   `uniqueItems` is restricted to primitive items on purpose: deep equality over
   objects would be key-order sensitive, so duplicate detection would depend on
   the child's key order — and these messages enter the replay key. Requiring the
   `uniqueBy` property in `items.required` is what keeps "missing" from becoming
   a third, invented uniqueness verdict; a child that omits it is already told
   `missing required property`.

   **Trimming is `String.prototype.trim`.** That is the canonicalization both
   `nonBlank` and `uniqueTrimmedItems` use. Declare `uniqueTrimmedItems` whenever
   the script trims labels afterwards, or a value the validator accepted can
   still collapse into a duplicate in the normalizer.

2. Appends a deterministic shape block (the JSON Schema plus "one JSON value,
   no prose") to the prompt the child receives.
3. Runs the child exactly as an ordinary `agent()` call — same catalog agent,
   same capability options, same live row, same `agent_start`/`agent_end` lines.
4. Parses the child's final text as JSON (a `json` code fence is tolerated) and
   validates it with the DSL's JSON-Schema subset validator:
   `type` (object/array/string/number/integer/boolean), `required`, `properties`,
   `additionalProperties:false`, `items`, `enum`, the size/pattern bounds, and
   the uniqueness/blankness keywords. Bound violations are reported by value
   (`tags: expected at most 2 item(s), got 3`) because the child has to decide
   what to cut. Uniqueness runs after the per-element pass and compares only
   elements whose runtime type matches the declared one, so a wrong-typed element
   reports its type error and nothing else. Every later duplicate is reported at
   its own index and names the first occurrence, so the child knows which of the
   two to edit:

   - `uniqueItems` — `dependsOn[2]: value "F1" duplicates item 0`
   - `uniqueTrimmedItems` — `options[1]: trimmed value "Keep" duplicates item 0`
   - `uniqueBy` — `findings[3].id: value "F1" duplicates item 0`
   - `nonBlank` — `prompt: expected a non-blank string, got 3 whitespace character(s)`
     (the count, not the value: a blank string can be hundreds of characters, and
     echoing them would splice junk into the retry prompt)

5. When the call declared `validate`, calls it with the parsed, schema-valid
   value. It never runs on a child that failed, returned empty text, overflowed
   `maxAnswerChars`, or produced an answer that did not parse or did not
   validate — a cross-field rule presupposes the shape holds, so author code
   never receives an off-shape value. A non-empty return is a mismatch owned by
   the script.
6. On mismatch, retries with a fresh child whose prompt carries the previous
   attempt's errors. A call without `validate` gets `SCHEMA_MAX_ATTEMPTS` (2)
   child runs total; a call with `validate` gets one dedicated extra attempt, 3.
7. Resolves to the validated value, or throws `SchemaValidationError` carrying
   `errors` and `attempts`.

**The host cannot force the child to answer in shape; the runtime enforces it
after the fact.** The Pi agent-session surface exposes no forced tool choice, so
the prompt block is advice and the parse/validate/retry/fail-closed boundary is
the actual contract. Practical consequence for authors: keep shaped stages small
and closed (`enum`, `additionalProperties: false`, few required fields) — a wide
schema is where a weak model spends both attempts.

**Fail closed.** There is no partial and no untyped fallback: either the value
validated, or the call throws. Inside `parallel()` / `pipeline()` the throw
becomes ordinary typed branch evidence and the group rejects after the barrier.
A child run that itself fails or returns empty text still throws
`WorkflowAgentExecutionError` and does **not** consume a schema retry.
The text options type has `schema?: never`; supplying a schema selects the
schema-required overload, so a shaped object cannot be returned under a string
type.

**Evidence.** Every attempt stamps `schemaValidation`
(`{status: "valid"|"mismatch", attempts, errors}`, plus `source: "schema" |
"script"` on a mismatch when the call declared `validate`) on its own `agent_end`
journal line, so a run's evidence shows whether a stage was shape-checked, which
authority rejected it, and how many tries it took. `attempts` is the 1-based loop
position of the attempt, not a count of live child runs: a replayed attempt
occupies an ordinal and increments it while contributing no `usage`. Each attempt
counts against `maxTotalAgentInvocations`; a call without `schema` counts exactly
once, as before.

### Advanced compatibility: `agent({ schema, validate })`

`schema` constrains one node. Referential integrity, agreement between two
fields, a budget summed across items and the shape of a graph are joins over the
whole answer, and teaching the validator to express them would grow the runtime a
general-purpose constraint language. `validate` is the alternative: the script
keeps the rule, and the runtime lends it the retry loop.

```js
const plan = await agent(prompt, {
  schema: PLAN_SCHEMA,
  // A per-call-site closure: the rule is checked against data the host owns.
  validate: (value) => findingPlanErrors(findings, value),
});
```

The contract:

- **It runs after schema validation succeeds, on the parsed value**, inside the
  same attempt and before `agent_end`.
- **It returns `string[]`; empty means pass.** It must not throw to signal a
  violation and must not return a transformed value — the call still resolves to
  the validated, untransformed value. Accumulate: with one retry, reporting only
  the first violation turns a repairable answer into a fatal one.
- **Its errors reach the child in their own labelled block**, never merged into
  the schema bullet list. Write them in the runtime's convention — 0-indexed JSON
  path, observed value, what would satisfy it:

  ```
  The previous answer (attempt 1 of 3) matched the required shape but was REJECTED by the workflow script for:
  - findings[0].dependsOn[0]: value "F9" is not a finding id in the review
  Return the corrected JSON value only.
  ```

- **It requires `schema`.** `validate` without one is a type error and a runtime
  error before any child runs, because the text overload has no parsed value to
  hand it; a non-function `validate` is refused the same way.
- **It must be pure, synchronous and deterministic.** A synchronous `string[]`
  return makes `await` impossible, and clock or randomness reads in the entry file
  already downgrade the script to `unproven`. Filesystem and network reads are
  **not** detectable and are forbidden by this contract. Calling back into the DSL
  throws: `agent() must not be called from inside a validate callback`.
- **The runtime bounds what it returns**: at most 32 errors, at most 500
  characters each, no empty string, no Promise. A breach fails the run closed and
  spends no retry — truncating would silently rewrite the replay key.
- **A throw is an author bug, not a model failure.** It propagates unchanged, ends
  the run, consumes no retry, and is journaled as `{kind: "error", source: "script"}`.

**What must NOT go in a validator.** A re-ask is safe only where the model's one
satisfying move is to comply — a membership, uniqueness, sum or graph re-check
over data the model does not control. Two classes can be talked past and must
stay fatal throws:

1. **Self-reported status** — the check accepts the model's word about something
   the host did not verify (`a verification pass cannot override failed
repository checks`). The repair bullet tells the model _why_ its success claim
   was refused, which is coaching toward a claim the host accepts.
2. **Verdict coherence** — a model's verdict graded against its own findings
   list ("a `revise` verdict requires at least one finding"). Re-asking offers two
   satisfying moves, fabricate a finding or flip the verdict, and both destroy the
   signal.

Host-owned continuation and provenance evidence, and text a _prior_ run's agent
wrote, are likewise not this child's to repair and stay fatal.

**Replay policy.** `validate` never joins the canonical request — `JSON.stringify`
drops functions silently, so including it would produce an identical key for two
different validators with no divergence signal. Its _body_ is covered instead: the
entry bytes are hashed and any change refuses the whole resume. It **is** re-applied
to replayed answers, held to the caller's current rule the way `maxAnswerChars` is;
and when the current validator rejects a replayed answer the run **fails closed**
rather than re-asking. Re-asking would form an attempt-2 prompt whose key misses at
that ordinal, trip the one-way divergence latch and silently convert the operator's
resume into a full live run. Because the error strings are spliced into the retry
prompt, they enter the replay key: a `Set` iteration order, a timestamp or an
absolute path in a message is a replay defect, not a cosmetic one.

---

## Run budget

Every run is bounded on seven axes without the script saying anything.
`DEFAULT_WORKFLOW_BUDGET` (`extensions/workflows/runtime/workflow-budget.ts`) is the single
source, and `runWorkflowScript` applies it to the runtime on every run:

| Axis          | Default           | What it bounds                                                                                                                                                                                                                    |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency` | `4`               | Simultaneously executing leaf agents across the WHOLE run, including nested `parallel()`/`pipeline()` wrappers. Equal to `SCHEDULER_WIDTH`, so a flat fan-out behaves exactly as before and only nested fan-out is newly bounded. |
| `totalAgents` | `200`             | Total `agent()` invocations, nested and retried ones included. Exceeding it throws `WorkflowInvocationCapError` and exits the run.                                                                                                |
| `runtimeMs`   | `7200000` (2 h)   | Wall clock over the agent chain. Exceeding it throws `WorkflowRunDeadlineError` and exits the run.                                                                                                                                |
| `timeoutMs`   | `600000` (10 min) | One child attempt. The SDK host's own child deadline is derived from this, so the workflow-level failure always wins; both timers remain within Node's maximum real delay.                                                        |
| `toolCalls`   | `1000`            | Tool calls per child attempt.                                                                                                                                                                                                     |
| `turns`       | `5`               | Assistant turns per child attempt, within the host clamp of 1..20.                                                                                                                                                                |
| `answerChars` | `500000`          | Characters in one child answer.                                                                                                                                                                                                   |

**What `runtimeMs` does and does not bound.** It is a deadline check performed
after a child acquires the run-wide concurrency slot and immediately before the
child starts — not a timer that
aborts a child mid-flight, because two abort paths for one child is the same
defect the single per-child deadline removes. So a run is bounded by `runtimeMs`
plus at most one child's own `timeoutMs`, and three cases are outside it: a script
that stops calling `agent()` (a `while (true)` of pure script code is not bounded
at all), script work after the last child returns, and that last in-flight child.
Nothing in the runtime bounds workflow script code today either; this is a
pre-existing limit stated rather than a new one introduced. "Bounded on every
axis" therefore means **the agent chain**.

**Narrowing versus raising.** A per-call value below the default applies silently.
A value above it applies too — a down-only rule would make a legitimately long
stage unauthorable, and the operator would answer by raising the package default
for everyone — but never silently: the runtime writes a `[workflow:budget] call
raised …` journal line naming the axis, the default and the requested value.

**Which axes a script can override.** The four per-call axes — `maxToolCalls`,
`timeoutMs`, `maxTurns`, `maxAnswerChars` — are ordinary `agent()` options. The
three run-level axes — `concurrency`, `totalAgents`, `runtimeMs` — are **host-side
only**: they are overridable through `RunWorkflowScriptOptions.budget`, which
embedders and tests pass, and through nothing a `*.workflow.mjs` can reach.
Neither production entrypoint passes it, so in practice every real run uses the
package values. Giving scripts a run-level surface means deciding where
operator-changeable knobs live, which is an open owner decision.

**Evidence.** Every run's journal opens with one runtime-source line listing the
applied budget, and `.pi/locus-pi/workflows/<runId>/outputs/README.md` carries a `## Budget` section
with each axis, its applied value, and the spend the run evidence can measure:
agent invocations, run wall clock, longest child, tokens, and the gate-owned peak
concurrency. The peak comes from the concurrency gate rather than from journal
intervals, because `agent_start` is written before the gate is acquired — counting
overlapping intervals would report queued children as concurrent. Replayed calls
are counted only where they really spend: one invocation against `totalAgents`,
but no child, so the row reads `N invocations (M replayed, no child ran)` and
their durations and tokens are excluded — a run served entirely from records
reports its longest child as "not recorded". Per-child tool
calls, turns and answer characters are enforced but counted by nobody, so they
print as "not recorded" rather than `0`. Tokens are printed when the host reports
them; cost prints as unavailable because `costTotal` is a hardcoded `0`, and a
limit over a stub reports "under budget" forever. Neither tokens nor cost is
enforced.

---

## Cheap one-shot decisions without a second primitive

There is no direct model-call node. `llm(prompt, opts?)` — one pi-ai
`completeSimple` / `streamSimple` completion with no child session and no tools —
existed until 0.2.x and was removed: two model-calling surfaces forced an author to
choose one before writing a stage, and a reused catalog agent constrained to a fixed
answer shape is not meaningfully more expensive than a direct call.

The replacement for a gate, a classification, or a short draft is a shaped child run:

```js
const gate = await agent(`Does this change need tool work? ${input}`, {
  label: "gate",
  schema: { type: "object", required: ["needsWork"], properties: { needsWork: { type: "boolean" } } },
});
if (gate.needsWork) {
  /* … */
}
```

That keeps one execution path, one journal shape, one option set, and one retry
budget. See "Opt-in shaped answers" above for the full contract.

**Model and host permissions.** The manifest still declares `models: true`: child
agent sessions reach models through the host. Separately, trusted workflow JavaScript
can use network-capable Node builtins or explicitly downgraded installed modules, so
manifest filesystem, subprocess, network and browser fields are conservative
`*`/enabled declarations. Those fields describe possible host capability; they do not
add a DSL primitive.

**Budget.** Each child run normally records token/cost `usage` on its `agent_end`
journal line. If script validation or artifact adoption throws after the child
answered, the sole terminal `error` line carries the same usage; transport errors
that never produced an answer carry none. `/workflows status` sums both executed
terminal shapes per run (`tokens=… cost=$…`). Observational only — there is no
hard cap.

---

## Approval / trust discipline

- **Permissions and tools:** every workflow child uses `permissionMode:
"inherit-parent"` and `tools: ["*"]`. Selecting a catalog role changes only
  prompt/model identity. Legacy `tools`, `readOnly`, and `permissionMode` call
  fields are ignored, so `write`, `edit`, `bash`, and all other available tools
  work without author-maintained allowlists.
- **Bounded repository checks:** `repository_check` accepts only
  a baseline `package.json` script name while the complete scripts map remains
  byte-for-byte equivalent to its pre-writer capture; added `pre`/`post` hooks,
  removals, and command changes are refused. It runs with host-owned argv in a
  disposable external Git worktree; it does not expose arguments or shell text.
  Initialized gitlinks are recursively overlaid with their current tracked and
  untracked source bytes, without copying submodule Git administrative metadata.
  Installed dependency roots — `node_modules` and `.venv` — are Git-ignored and
  therefore absent from that snapshot, so the snapshot borrows each one that
  exists as a symlink to the project's own directory; without them a declared
  check dies at startup (`sh: vitest: command not found`) and a verifier reads
  that as "the suite could not run". The borrowed link is unlinked before the
  snapshot is removed, so cleanup never deletes through it. A check that writes
  inside a borrowed dependency root writes to the project's real directory — the
  isolation guarantee covers the repository's own files, not a package manager's
  install tree.
  `git_read` accepts argv for
  allowlisted Git queries and rejects mutation, output-file, external-diff,
  textconv, pager, signature, and config options before launch.
- **Workspace:** `workspaceMode: "project"` keeps the child in the current project working directory. `workspaceMode: "worktree"` and `"temporary-worktree"` make the bridge create a retained git worktree under `.pi/locus-pi/workflows/<runId>/worktrees/<call-id>/`, then pass that path as `AgentRunRequest.workingDirectory`.
- **Deprecated alias:** `sandbox: "read-only"` maps to `workspaceMode: "project"`; `sandbox: "workspace-write"` maps to `workspaceMode: "worktree"`. It never changes the tool set. New workflows should use `workspaceMode`.
- Pi native approval policy owns whether the underlying write-tier calls are allowed, prompted, or denied.
  The worktree isolates file changes for diff UX purposes, but it is not a security boundary.

---

## Fail-closed behavior

When the Pi SDK host cannot spawn a child agent session:

1. `createAgentSdkSessionExecutor` returns `status: "blocked"` with `failureCause: "sdk-unavailable"`, and `diagnostics` containing `AGENT_SDK_UNAVAILABLE_DIAGNOSTIC` for a human reader.
2. `workflow-agent-bridge.ts` branches on that typed cause — never on the diagnostic text — and throws `WorkflowAgentUnavailableError`, carrying the same `failureCause` and the honest `AGENT_SDK_UNAVAILABLE_HINT` ("Pi SDK host") reason. Re-wording the diagnostic therefore cannot turn a run-ending failure into a blocked result a script might read as an answer.
3. A bare `agent()` call rejects (propagates the error to the script).
4. Inside `parallel()` / `pipeline()`, the branch is marked failed; scheduled siblings finish, then the group rejects `WorkflowGroupFailureError` instead of returning a normal `null` slot.
5. If the script does not deliberately catch that stable typed error, `runWorkflowScript` writes a JSON-safe group-failure `result`, persists outer `ok:false`, and returns the group error text. A deliberate typed catch must return `partial:true`, which also remains non-success.

**No fake success is ever reported.**

---

## Resume and replay

`/workflows run <name> --resume <runId>` reruns the workflow against a recorded
run. Every `agent()` call whose **position** and **exact request** match the
record returns the recorded child text without spawning a child, so iterating on
the last stage of a long pipeline no longer pays for the earlier stages.

### What is compared

The key is the call's ordinal position plus its fully resolved request: the
prompt, catalog `agent`, `maxToolCalls`, `model`, `label`, `phase`,
`workspaceMode`, and any `workspaceHandle`.
A declared `schema` needs no separate field — the shape contract is already part
of the prompt the child receives, and each schema retry is recorded as its own
call, so a shaped stage replays its retries exactly as it ran them.

Replay is a **strict prefix**. The first call whose key does not match the record
invalidates that call _and every later call_, including calls whose own prompt
did not change: a later recorded answer was produced after an earlier answer that
no longer exists, so reusing it would misreport what the run observed.

### When replay is refused

Refusal is never silent — the reason is written to the journal and to
`result.json`, and the run executes normally.

| Reason                       | Meaning                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `source-run-unusable`        | the named run has no readable persisted script identity                                              |
| `script-changed`             | `scriptSha256` differs from the recorded run's                                                       |
| `identity-coverage-unproven` | the script declares `entry-only`, so imported bytes could move calls without changing the entry hash |
| `replay-unsafe-script`       | the AST found direct clock/randomness syntax (below)                                                 |
| `no-recorded-calls`          | the recorded run wrote no replay record                                                              |

### Replay-safety is scanned, not asserted

There is no `meta.replaySafe` field, deliberately. An author assertion fails
open: a script that claims to be replay-safe and calls `Date.now()` would replay
answers produced in a different world and look green. Instead the same AST scan
that classifies import edges also looks for direct clock and randomness syntax.
Any hit makes the script `unproven`: it still runs normally, it is simply never
recorded and never replayed.

The nondeterministic roots are `Date.now`, `new Date(…)`, `Math.random`,
`performance.now`/`timeOrigin`, `crypto.randomUUID`/`getRandomValues`, and
`process.hrtime`/`uptime`. The scan folds these forms of reaching them:

| Form                                  | Example                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| direct member access                  | `Date.now()`, `Math.random()`                                                                  |
| computed member access                | `Date["now"]()`                                                                                |
| through the global object             | `globalThis.Date.now()`, `global.Date.now()`, `self.Math.random()`, `globalThis["Date"].now()` |
| a computed global member              | `globalThis[key].now()` — unfoldable, so always unproven                                       |
| construction, parenthesised or not    | `new Date()`, `new (Date)()`, `new globalThis.Date()`                                          |
| a fresh binding for the root          | `const d = Date`, `const { random } = Math`, `m = Math`                                        |
| a named `node:` import                | `import { randomUUID } from "node:crypto"`, `import { performance } from "node:perf_hooks"`    |
| a default or namespace `node:` import | `import c from "node:crypto"` — the module is renamed, so it is flagged wholesale              |

That last pair matters more than it looks: `node:` specifiers are exactly what
keeps a script `self-contained-static`, so an ESM import of `randomUUID` would
otherwise be the one bypass the identity gate actively invites.

**What the scan still cannot see.** It reads syntax, not behavior, so it is a
filter and not a proof:

- access assembled at runtime — `globalThis[k]` where `k` is computed elsewhere,
  `Reflect.get`, or a root threaded through a function parameter or property bag;
- a nondeterministic value smuggled in through `process.env`, `argv`, or a file;
- anything inside an imported module — which is exactly why `entry-only`
  coverage counts as unproven and is never recorded at all.

So the honest claim is narrower than "replay is proven safe". The gate that
actually prevents a wrong replay is the per-call request key plus the prefix
latch above: nondeterminism that reaches a prompt, or that changes call order or
count, produces a key mismatch and fails closed. This scan reduces how often that
gate is the only thing standing, and it errs toward `unproven` — a false positive
costs a cache miss, a false negative would replay an answer from a different
world. Reach for `dsl.now()` / `dsl.random()` and the question does not arise.

The folded forms above are each covered by a case in
`tests/shared/workflows/workflow-replay.test.ts` (`static replay-safety
assessment` and `replay-safety bypasses are refused end to end`).

### A replayed run is always marked

A replayed call is recorded evidence, not fresh evidence, and every surface says
so:

- `journal.ndjson` — `agent_start` / `agent_end` carry `replayed: true`.
- `result.json` — a `replay` envelope with `replayed`, `recorded`, `sourceRunId`,
  `refusedReason`, `notRecordedReason`, `replayedCalls`, `freshCalls`, and
  `divergedAtCall`.
- `/workflows status` — `replayed=<n>` on the run row, and a detail line reading
  `N/M agent call(s) reused a recorded run — not fresh evidence`.
- the live progress panel — `replayed=<n>` in the header.
- `/workflows status <runId>` timeline — `[replayed]` on the agent rows.
- the bounded command/tool lifecycle digest — `[replayed]` on the agent lines and
  `N replayed from a recorded run` on the final line. This is the one workflow
  surface that enters LLM context, so a model reading it cannot mistake recorded
  evidence for work that just happened.

A replayed call reports **no** token usage, so the run budget shown by
`/workflows status` counts only work that actually happened.

### Limits, stated plainly

- **Replay reuses answers, not side effects.** A child that wrote a file on the
  first run does not write it again. Calls that ran under a worktree
  (`workspaceMode` other than `project`, or any `workspaceHandle`) are therefore
  never replayed even on a clean key match; they re-run. For a
  `project`-mode child that wrote a file, the marking above is the mitigation,
  not a guarantee that the filesystem still matches.
- **A replayed call does not re-read either — its answer describes the tree as
  it was.** Replay is keyed on `(ordinal, resolved request)` and never on the
  state the child read. This is the sharper edge of the bullet above, because it
  bites in exactly the scenario `--resume` exists for: you changed something and
  want to rerun the last stage. An earlier `project`-mode stage that had read
  those files replays its recorded answer about the _old_ tree, with a
  byte-identical prompt and no divergence. That is by design — nothing is
  fabricated and every surface marks it `replayed` — but if an early stage's
  answer must reflect your edit, change that stage's prompt or resume from
  further back.
- **`parallel()` wider than the scheduler is a cache miss, not a wrong answer.**
  Ordinals are assigned as calls start, and a group with more branches than the
  scheduler width (4) may start them in a different order on the second run. That
  breaks the prefix and the remaining calls run for real. Sequential pipelines —
  the case this feature exists for — are fully deterministic.
- **Resume is not Pi session continuation.** The child session is not resumed;
  only the workflow-level answer is reused.
- **A recorded failure is not replayed.** It keeps its ordinal so the prefix
  before it still replays, and the call itself runs again — which is what
  "resume to fix the stage that failed" means.
- **The prefix latch fires on key mismatch, not on a changed outcome.** A call
  that re-runs at a matching key — a recorded failure that now succeeds, or a
  worktree stage that is never replayed — does _not_ break the prefix. Its
  successors, if their own keys still match, keep replaying. So a stage whose
  recorded answer was produced in a run where its predecessor had failed can be
  replayed into a run where that predecessor succeeded. Nothing is fabricated:
  the text is a real child answer to a byte-identical request, and the run is
  marked `replayed`. But "the prefix before the divergence replays" is only half
  the rule — the prefix _after_ an outcome change replays too, and only a
  changed request key stops it.
- Recording is skipped entirely for `unproven` and `entry-only` scripts, so those
  runs write no `replay.ndjson` and cannot be resumed.

---

## Journal layout

```
.pi/locus-pi/workflows/<runId>/
  outputs/           — README, semantic documents, exact workflow-result.md prose
  workspace/         — files deliberately written by workflow agents
  runtime/
    script-<sha256>.workflow.mjs — Read-only bytes evaluated for this run
    journal.ndjson    — NDJSON lines: {ts, runId, kind, source?, phase?, message?, agent?, usage?, replayed?, ...}
                      kinds: phase | log | agent_start | agent_end |
                             group_start | group_end | error
    replay.ndjson     — Recorded agent answers + dsl.now()/dsl.random() values for --resume;
                      absent for scripts that are not replay-safe (see "Resume and replay")
    result.json       — Final result + disposition + full journal snapshot + identity/replay envelopes
    artifacts/
      index.json       — Canonical digest-bound inventory for this run
      answers/         — Exact automatic agent answers
      transcripts/     — Fresh child Pi session JSONL, grouped by call id
      results/         — Fresh child result envelopes, grouped by call id
      published/       — Text written through publishArtifact()/publishPrimaryArtifact()
      inputs/          — Verified copies consumed from prior runs, with source refs
```

`agent_end` carries `usage` (token/cost), the resolved `model`, and — for a shaped call —
`schemaValidation` (with `source: "schema" | "script"` on a mismatch when the call declared
`validate`), plus full answer/transcript/result artifact references when
those records exist. `/workflows status` shows `agents=…` and sums the run budget from those
`usage` values. Journals written before 0.2.x may still contain `llm_start` / `llm_end` /
`llm_delta` lines; they parse but are no longer counted or specially rendered.
`parallel()` and `pipeline()` group lines are local observability metadata: they
summarize current DSL structure and record accurate completed/failed barrier counts.
They do not add upstream dynamic fanout, acceptance evaluation, async detach,
interrupt/resume, or append-step semantics.

---

## Agent catalog

Workflow scripts declare an agent role at the call site:

```js
await agent("Inspect the repository and report evidence."); // catalog agent "default"
await agent("Apply the bounded edit.", { agent: "quick_task" });
```

`opts.agent` is a catalog name, not a model name or an inline role definition.
Bare `agent(prompt)` selects `default`. The bridge discovers definitions first-wins
by agent name from the nearest project `.agents/agents/`, then
`~/.agents/agents/`, then the package's bundled `.agents/agents/`. Unknown names
return an explicit `ok:false` agent result; they do not silently use `default`.
For workflow calls, each definition's frontmatter supplies the system prompt and
optional `model` preference; catalog capability metadata does not narrow the
inherited workflow-child surface. The current bundled catalog
includes `default`, `designer`, `explore`, `librarian`, `local_file_worker`,
`oracle`, `plan`, `quick_task`, `reviewer`, `task`, and `workflow-author`; project
or user definitions may shadow these names.

### Model selection: execution versus metadata

One precedence chain decides which model a child runs on, and it is the same
chain for a workflow stage and for `/agent run` / `spawn_agent`:

```
opts.model  →  opts.modelRole  →  the agent's frontmatter tier  →  ctx.model
```

Every term but the last is resolved through the host's model registry
(`ctx.modelRegistry.find`) BEFORE the child is created, and the resolved model is
what `createSession` receives. Two outcomes, and the difference between them is
the point:

- A **concrete** `provider/id` selector that does not resolve — a typo, a provider
  that is not configured, a model this host does not have — ends the call with a
  named failed result and zero child sessions. It never silently inherits.
- A **role** that no model-roles layer assigns degrades to `ctx.model` and records
  `modelRoleFallback` on `agent_end`, in the `locus.agent.run-result.v1` body and
  in the run report. The package deliberately ships no role assignments, so this
  is what a stranger sees until they write their own — a bundled agent must not
  fail closed just because nobody has configured a tier yet.
- A role whose assignment EXISTS but does not parse as `provider/id[:level]` is a
  configuration error and fails the call by name, quoting the value as written and
  the layer holding it. It is deliberately not treated as unassigned: degrading a
  typo would run the session model under the requested tier's name and report the
  role as unassigned, which the operator's own config contradicts.

The frontmatter tier still resolves through the effective role order `session` →
Pi settings → project config → user config, falling back across `agent`, `task`,
then `default`; a per-call `modelRole` does **not** use that purpose fallback,
because an author who named a tier asked about that tier. `modelRoleResolution`
continues to be recorded in the request capsule, artifacts, and live display.

**The pre-tier `pi/<role>` namespace.** Before tiers were executed the shipped
agents wrote their tier as `pi/<role>`; `pi` was never a provider and nothing
read the value. An agent's **frontmatter** tier in that namespace is read as the
role it always named, so a catalog copied from an older release resolves through
the roles table instead of refusing every call as an unresolvable provider. The
degradation note for an unassigned one carries an extra sentence naming the
spelling to fix. This is package history being repaired, not a hole in the
grammar, and it is bounded on both sides: `pi/<token>` where the token names no
role is an ordinary concrete selector and still fails by name, and a per-call
`model` / `modelRole` — code written today against the current grammar — still
refuses with the migration hint rather than being rewritten.

**Running a workflow on your own local model.** The package assigns no role, so
the shortest path is to change nothing: every bundled agent names a role,
nothing assigns it, and the child therefore inherits the parent session's model —
whatever `/model` currently points at, local provider included. Each such child
records the degradation, which is a statement of fact rather than a fault. To
make the choice explicit instead of inherited, assign the roles the catalog
names — `task` and `agent` cover the bundled agents — to your own
`provider/id` with `/model-roles`, and the resolved model is what `createSession`
receives.

**Selector grammar.** A token containing `/` is a concrete `provider/id`; a
slash-free token is a role name looked up in the roles table. A trailing
`:off|minimal|low|medium|high|xhigh` is stripped before the registry lookup,
then passed to the child session as `thinkingLevel` and retained on the live
row. A concrete model or effort the installed Pi host cannot honor fails the
child creation boundary rather than silently changing either value.

**What executed, versus what was asked for.** `agent_start` is emitted before the
bridge resolves anything, so it carries `requestedModel` / `modelRole` — intent,
named as intent. `agent_end` carries `executedModel`, read back from the child
session after `createSession`. When the peer exposes no model the field records
`unavailable`; it is never back-filled from the request. A readback that
contradicts the resolved request fails the call with both values quoted, because
a host that ignored the selection is exactly the failure this evidence exists to
catch.

**Nothing is named as executed before the child is dispatched.** `executedModel`
— and with it the recorded tier degradation — appears only once the child's first
prompt has been accepted by the transport. A call that was refused at the tier, a
session built and then cancelled before kickoff, a readback mismatch, or a
`prompt()` the transport rejected (no credentials, no route) executed nothing and
reports nothing. **The live row follows the same rule**: on every one of those
paths it drops the requested selector instead of ending as a terminal row wearing
a model that never ran, which an operator cannot tell apart from one that ran and
failed. Absence is the honest answer there; the failure reason carries the
details.

**And nothing that did run is forgotten.** The same rule read the other way: a
call that fails _after_ the child answered — a script `validate` that threw, an
artifact writer that could not write — really did execute, so its `error` line
carries `executedModel` and the row keeps that label rather than being blanked as
if no child existed. A **replayed** completion is the opposite case and is treated
as such: a resumed run serves a recorded answer without creating a child, so its
`agent_end` has no readback and its row shows no model even though the status is
`completed`. Read `executedModel` as the single proof of execution on any terminal
line — its absence always means "no child ran", never "the record was lost".

**Replay identity, and one residual to know about.** `modelRole` is part of the
canonical request, so two stages on two tiers occupy two records. The key is
built in the runtime before the bridge consults the roles table, so it identifies
the tier a stage **declared**, not the model that produced the answer: remapping a
role in `.pi/model-roles/config.json`, or editing an agent's frontmatter, reuses
the existing record. **A roles-table change invalidates recorded runs by hand.**

`meta.description` has no effect on any of these choices. `/workflows info`
reports the rules but never resolves them into a claimed future execution graph.

---

## Default package

`workflows` is registered in `package.json#pi.extensions` and loads by default; the
`/workflows` command and `workflow` tool are available without manual loading.
See [docs/extension-ownership-matrix.md](../../extension-ownership-matrix.md) for the full status.
