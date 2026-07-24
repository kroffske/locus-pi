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

A Pi-native dynamic-workflow runtime that provides a DSL (`agent / publishArtifact /
consumeTextArtifact / awaitOperator / parallel / pipeline / phase / log / promptFile / workspace`)
for orchestrating catalog-agent sessions through the existing
`task / createAgentSession` path and retaining their evidence under one run root.

One way a workflow reaches a model:

- **`agent()`** — spawns a full catalog or workflow-local child session and returns
  its exact non-empty final text, routed through the same code path as the `task`
  tool. With `opts.schema` it returns a validated value instead; see "Opt-in shaped
  answers" below. There is no second model-calling primitive: a direct one-shot
  completion node (`llm()`) existed until 0.2.x and was removed so that an author
  never has to choose a surface before writing a stage.

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

| Seam                                | Location                                                                                          | Status                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded concurrency                 | `extensions/_shared/workflow-runtime.ts` `runScheduled()`                                         | DONE (per-call). `parallel()`/`pipeline()` run through a bounded worker pool (`SCHEDULER_WIDTH = 4`) that preserves input ordering. Width bounds each `runScheduled` call, not globally. A **global limiter** + width tuning remains a future scheduler task.                                                                                                                         |
| Git-worktree isolation              | `workflow-agent-bridge.ts`, `workflow-worktree.ts`                                                | DONE for `workspaceMode: "worktree"` / `"temporary-worktree"`: each isolated agent gets a retained `.locus/runtime/workflows/<runId>/worktrees/<call-id>/` git worktree before child execution. Merge-back remains out of scope.                                                                                                                                                      |
| Trusted script execution            | `extensions/_shared/workflow-runner.ts` `loadWorkflowScript()`                                    | Author scripts are **reviewed trusted input**. Default `self-contained-static` restricts declared module edges for identity evidence; explicit `entry-only` keeps full modular Node.js access. Neither mode isolates capabilities. A real isolate is a future seam, not current protection.                                                                                           |
| Owner-default agent + model routing | `extensions/_shared/workflow-runtime.ts`, `workflow-agent-bridge.ts`, `.agents/agents/default.md` | DONE. Bare `agent(prompt)` resolves to catalog agent `default`; explicit `agent(prompt, { agent: "quick_task" })` keeps the mechanical worker path. Model routing keeps per-call `opts.model` precedence, keeps agent frontmatter `model` visible in the request capsule through model-role resolution, and otherwise lets the child executor use the current session model fallback. |

---

## Curated Package workflows

| Workflow             | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Minimal **live proof**: 2 read-only agents each do one small tool action and report. Cheap (~2 agents). Run it to confirm the host can actually spawn child agents; verify via `result.json`.                                                                                                                                                                                                                                                                                                                                               |
| `requirements-grill` | Read-only **requirements refinement**: requires ripgrep (`rg`) on `PATH`. The trusted workflow script runs `rg` directly with fixed arguments, sanitized request keywords, a 10-second timeout, and 200-line/40,000-character result caps. Three no-tool default children then map, challenge, and synthesize exact text handoffs from that artifact. Empty input fails at `validate-input`; missing `rg` fails closed at `collect-context`; the final child text is retained in `result.json`.                                             |
| `review`             | **Question-led code review**: semantic text first reaches a shaped read-only clarifier. It either continues or persists exact intent/questions and stops; a later text answer call attaches those two refs through host continuation. Five sequential read-only agents then resolve scope, inventory the change, plan review units, ask falsifiable questions, and verify them independently. Runtime reconciles every `C<n>` coverage id and bounds every handoff before accepting runtime-owned `review.md`; there is no publisher agent. |
| `review-fix`         | **Human-gated remediation**: semantic text plus host continuation supplies the immutable terminal `review.md` answer from a Package `review` run. A shaped read-only selector plans 1–20 finding units and dependencies; deterministic code validates ids, notes, edges, cycles, terminal provenance, and context bounds before writers. Stable topological order gives one writer to each selected finding, then a read-only checker and fresh dependency-aware re-review run.                                                             |

`review` always receives a non-empty semantic string. A shaped read-only
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
The entry also enforces the handoff rather than trusting model prose: inventory
must declare unique `## C<n>` headings, unit ledgers must assign each id exactly
once, and questions plus the final report must use one exact `C<n>: U<n>; ...`
ledger row per id with the unit assignment preserved. Missing, duplicate,
unknown, malformed, or misassigned ids and oversized intent, clarification,
stage, or final text fail the run before a report can be accepted.

The unit planner, interrogator, and verifier may also use `ast_index`, an
allowlisted argv tool over the installed `ast-index` binary, for code-symbol
relationships. Its database lives in the user cache directory, so index
refreshes never touch reviewed source. A missing binary or index degrades to
`grep`/`find` and is recorded as a coverage limit instead of blocking the
review.

The two review workflows have independent package directories:
`extensions/workflows/examples/review/` and
`extensions/workflows/examples/review-fix/`. The reader algorithm lives in
`review/README.md`. Each `resources/*.prompt.md` file contains both the stable
role instructions and the dynamic handoffs for one concrete stage.
`promptFile()` resolves paths relative to the original workflow source, rejects
lexical or symlink escapes, copies bytes once into the run directory, and
records SHA-256 evidence.

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

The continuation must contain exactly one complete immutable `review.md`
reference from the `verify-review` stage of a successful Package workflow named
`review`; a same-name artifact from another workflow or stage is refused. The
host verifies all four fields and the bytes, then copies the review into the new
run with source lineage before workflow code starts. The entry additionally
requires those bytes to equal the source
`result.json.result` and the exact reference to be the terminal projected output;
editing only artifact-index kind/stage metadata cannot promote another file.
A no-tool read-only selector receives the operator text and immutable review,
then returns 1–20 `{id,note,dependsOn}` units through the fail-closed shaped
agent boundary. Deterministic code bounds all notes and handoffs, parses complete
`### F<n>` blocks, rejects duplicate/unknown ids, duplicate/self/unknown edges,
unselected dependencies and cycles, and computes stable Kahn order with original
review order as its tie-break.

One read-only scope resolver receives only the selected complete finding blocks.
Exactly one sequential write-capable agent then owns each selected finding, so
overlapping mutations have a visible order and one accountable writer. The host
captures Git HEAD, index, status, and changed/untracked byte fingerprints before
remediation, around each writer, around checks, and before re-review. Every
initialized gitlink is enumerated independently of its parent modification
state, then its submodule HEAD, index, status, and changed/untracked bytes are
included. These
artifacts distinguish declared writer-window changes from source drift; they do
not lock the checkout. A separate host-enforced read-only child reopens the full
diff and may call `repository_check` with only a `package.json` script whose exact
command was frozen when the workflow runner was created, before any writer. A
script-map addition, removal, or modification is refused in both the launch checkout and the
materialized snapshot. The host, not the model, supplies argv, timeout, output bound, and a
disposable external Git worktree containing the current tracked/untracked bytes;
initialized submodule source is recursively materialized without copying Git
administrative metadata. The operator checkout is never the command cwd. A fresh read-only re-review
receives the immutable original review, bounded worker answers, check evidence,
and source-state transitions; it reopens the source and reports every original
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
ordinary diff review. The scope resolver and re-review are host-enforced
`readOnly`; the checker has neither edit tools nor shell. A declared package
script is operator-owned executable code, so the disposable worktree is a
mutation boundary for the checkout, not an OS/network sandbox.

Both entry scripts use only the injected DSL and retain default
`self-contained-static` identity; `review-fix` no longer imports a helper. Prompt
resources still receive immutable run copies and SHA-256 evidence. Repository
and private-forge evidence acquisition remains child-agent-owned. Prompt text and
permission metadata are not a sandbox; resource, artifact, or child execution
failure remains fail-closed.

Runtime-owned Markdown is the human-facing evidence. Mandatory `result.json`
remains the machine-readable run envelope, while
`.locus/runtime/workflows/<runId>/artifacts/index.json` is the canonical map from
logical artifact identities to digest-bound bytes.

These four names form the Package registry. They are intentionally small and
owned as part of the package product surface, not discovered merely because a file
exists in `extensions/workflows/examples/`.

Editable pipeline maps:

- `live-smoke`:
  [PNG](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/live-smoke-pipeline.png) ·
  [Excalidraw](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/live-smoke-pipeline.excalidraw)
- `requirements-grill`:
  [PNG](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/requirements-grill-pipeline.png) ·
  [Excalidraw](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/requirements-grill-pipeline.excalidraw)
- `review`:
  [PNG](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/review/review-pipeline.png) ·
  [Excalidraw](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/review/review-pipeline.excalidraw)
- `review-fix`:
  [PNG](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/review-fix/review-fix-pipeline.png) ·
  [Excalidraw](https://github.com/kroffske/locus-pi/blob/main/extensions/workflows/examples/review-fix/review-fix-pipeline.excalidraw)

## Authoring patterns

The clean release contains no uncurated Package examples. The pattern catalog
`extensions/workflows/references/patterns.md` provides inline skeletons that an
operator may save under a reviewed project or user workflow directory. Saving a
local workflow does not add it to the Package registry.

This repository dogfoods that boundary with ignored project files under
`.pi/workflows/`: `locus-plan.workflow.mjs` exercises clarification, planning,
digest-bound split-run execution, and per-unit implementation; `test-code.workflow.mjs`
separates testcase design, test implementation/execution, and failure
attribution among independent agents. Their independent final verifier and
attribution agents are host-enforced read-only and can run only frozen
`repository_check` scripts; bounded intent, plans, units, predecessor results,
execution evidence, and final inputs fail closed. They are local operational examples, not
tracked source, curated names, documentation shipped in the npm tarball, or
public package support promises.

For _which shape to pick_ (single-agent, shaped-answer gate, loop+judge, plan→build→review,
pipeline, fan-out+merge, judge-panel, loop-until-dry), see the pattern catalog
`extensions/workflows/references/patterns.md` — it maps each requirement to a minimal
skeleton to adapt. Only the four workflows in the curated table
above are registered Package workflows. (Single source: that file is the catalog of
_forms_; this doc remains the DSL _contract_.)

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
4. The curated Package registry — human source `Package`; currently `live-smoke`,
   `requirements-grill`, `review`, and `review-fix`.

The first eligible source for a name wins and its exact resolved path is retained.
Project and user directories are scanned on each resolve/list/info call, so adding or
removing a valid file changes the next result and removing a shadow reveals the next
source. Package registration is explicit in `CURATED_PACKAGE_WORKFLOW_NAMES`; adding or
removing a file under `examples/` alone does not change the catalog. An already-open
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

```
/workflows                        reopen the oldest pending operator question, or show the workflow home
/workflows run live-smoke         start one background workflow (returns editor)
/workflows stop [runId|last]      request cancellation; terminal state follows settlement
/workflows run live-smoke --resume <runId>  replay that run's recorded agent calls (see "Resume and replay")
/workflows dashboard              persisted run → stage → evidence viewer
/workflows list                   current first-wins workflows + run-specific immutable history
/workflows list <query>           filter catalog by name or description
/workflows info                   explain discovery, metadata, trust, DSL, agents, and model routing
/workflows info <name>            add exact first-wins source/path, static meta.description and declared phases
/workflows status                 interactive persisted viewer; bounded run list without custom UI
/workflows status <runId>         interactive stage evidence; bounded detail without custom UI
```

The same owners are available as first-class commands:

```
/workflow-run <name|path> [input]
/workflow-stop [runId|last]
/workflow-list [query]
/workflow-info [name]
/workflow-status [runId]
/workflow-continue <runId> [--answer <text>]
```

Pi's native slash-command filtering exposes these complete names and Tab selects
them without first entering `/workflows`. The compatibility
`/workflows <subcommand>` forms remain supported and keep their argument
completion for workflow names, persisted run ids, `last`, and replay ids.
Catalog queries, paths, and semantic input remain free text.

An actionable `awaiting_operator` handoff opens directly in the primary editor
after Pi becomes idle. There is no workflow/run picker. Multiple handoffs are
oldest-first and show `Question 1 of N`; answering launches one
integrity-checked continuation before the next item opens. Escape only closes
and snoozes the question for the current session. The source run stays waiting,
and bare `/workflows` reopens it. Only `/workflow-stop` (or its compatibility
form) cancels a workflow.

`/workflow-continue <runId>` collects answers interactively in TUI and RPC.
`--answer` is the explicit non-interactive path and accepts exactly one
question: closed selections require an exact label, while custom-enabled
questions accept other non-empty text. Multi-question handoffs fail closed
instead of guessing how one string should be distributed.

Mode behavior stays explicit:

| Pi mode            | Question projection                            | Answer collection                          |
| ------------------ | ---------------------------------------------- | ------------------------------------------ |
| TUI                | Automatic primary-editor select/text component | Arrows, Enter, or inline custom text       |
| RPC                | Command/static projection                      | Native bidirectional extension UI requests |
| JSON/print         | Readable one-way lifecycle output              | `/workflow-continue … --answer …` only     |
| Embedded child SDK | Existing `session.subscribe(...)` observation  | Not applicable                             |

Pi 0.82.0 is the minimum supported host for automatic questions. Locus
serializes its own inline components and rechecks the current idle session before
mounting. Pi exposes no global custom-UI lock for unrelated third-party
extensions, so `/workflows` is the recovery path if another extension displaces
the question.

Every run is persisted to `.locus/runtime/workflows/<runId>/` (`journal.ndjson`
while running, `result.json` when finished), so `status` works across sessions and
after the fact.

### Persisted run artifacts and viewer

The canonical artifact inventory is
`.locus/runtime/workflows/<runId>/artifacts/index.json`. Every record includes a
logical id/name, media type, byte size, relative path, stage, provenance, and
SHA-256. Its portable identity is always the complete object
`{ runId, artifactId, name, sha256 }`; a run id or path alone is not an artifact
reference.

Every `agent()` attempt receives a stable `call-<n>` identity before scheduling.
The runtime persists the exact non-empty child text under `artifacts/answers/`.
A fresh child session must also export a Pi session transcript under
`artifacts/transcripts/<callId>/` and a JSON result envelope under
`artifacts/results/<callId>/`; missing evidence makes the call fail before its
terminal `agent_end` is emitted. A replayed call writes a new answer record with
`provenance: "replay"` and its source run id, but invents no transcript or result
envelope because no child ran.

Authors can add or connect deterministic text evidence through three surfaces:

- `publishArtifact(name, text)` writes bounded workflow-authored Markdown under
  `artifacts/published/` and returns its full reference.
- `consumeTextArtifact(ref)` accepts only a full prior-run reference, requires the
  source run to have `ok:true`, requires the exact ref in its terminal
  `artifactRefs` projection, verifies index identity, media type, size, digest,
  path confinement, and bytes, then copies them under `artifacts/inputs/` with
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
through `.locus/runtime/workflows/<runId>` before any artifact read, write, or
consume, preventing a redirected canonical root.

At run completion, `result.json` and the model-callable `workflow` tool project
up to the newest 20 reader-facing answer/published refs as `artifactRefs`; an
`artifactRefsOmitted` count makes truncation explicit. Each projected item is the
same complete `{runId, artifactId, name, sha256}` identity verified by the index.
This bounded projection is the handoff for a later workflow; the full inventory
remains in `artifacts/index.json` for inspection only. The caller must use a
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

The background run installs a compact `belowEditor` widget. Its header identifies the workflow and run, the stage frontier preserves declaration order, and each stage is labelled only as `declared`, `reached`, or `current`; only an explicit `kind: "phase"` journal event makes a stage reached or current. Phase metadata on agent, group or log events remains grouping context. One active child row is rendered through the shared `AgentLivePanel`; parallel/group rows remain visible context headings but are not selectable. Round retries retain the same stage slot and add an `rN` marker. `/ps` opens the agents extension's shared fleet selector directly from the current `agentLiveStore`; widget render order never chooses its rows. `Shift+Down` is an optional terminal shortcut, not the primary contract. `Enter` opens transcript output or a recorded replay answer whose digest was checked by the workflow event adapter. `Esc`/`q` close or go back without aborting. Workflow-owned rows carry explicit run provenance and expose no `x` action; use `/workflows stop [runId|last]`. Standalone agent rows retain their confirmed `x` behavior.

The detached run adapter and transcript callbacks carry the originating Pi session generation; late completion therefore cannot write through them into a new session. The progress component's live-store listener and spinner timer are instead session-owned resources: the extension disposes them synchronously on session start/shutdown and idempotently on terminal, error, and `finally` paths, even when a runner ignores abort and settles later. `session_shutdown` (including reload) also aborts active work. This lifecycle uses Pi's documented [`session_shutdown`](https://pi.dev/docs/latest/extensions#events), [`input`/`turn_end`](https://pi.dev/docs/latest/extensions#events), and [`setWidget(key, undefined)` cleanup](https://pi.dev/docs/latest/extensions#widgets-status-and-footer) seams, plus the one shared agent-row formatter.

Transcript persistence follows the Pi surface that started the run. The slash-command path does not call `sendMessage` for start or intermediate events, because a long workflow can outlive the launch-time idle check. It keeps the bounded lifecycle in memory while widget/status surfaces show live progress. After the workflow finishes and the completion UI is updated, the command awaits the real `ctx.waitForIdle()`, rechecks `ctx.isIdle()`, and immediately writes one visible digest through `pi.sendMessage({ customType: "locus-workflow-event", display: true, ... }, { triggerTurn: false })`. There is no await between the final idle check and the send call, so Pi's synchronous routing appends instead of steering. The call omits `deliverAs` and does not start or queue a model turn. The one digest is stored and participates in later LLM context.

The programmatic `workflow` tool never calls `sendMessage` while its tool output may be streaming. It buffers the same lifecycle and appends one digest to the single ordinary final `toolResult` text; Pi therefore persists it through the native tool-call transcript without an extra turn. Streamed progress updates remain presentation-only. Both paths cap each line at 160 characters and keep at most 20 agent transitions plus start/final, so a digest has at most 22 lifecycle lines and 4096 characters. Raw result/journal detail never enters the digest. Workflow agent lines use the stable catalog `agent` plus `label` and status, not the workflow parent-row petname: the live panel may collapse that parent in favour of an SDK child with a different canonical petname. Terminal markers are status-aware: `✓ … finished` only for `completed`, `◐ … awaiting operator` for a successful handoff, `⊘ … cancelled` for `cancelled`, and `✗ … failed` for `failed`. Journal `error` lines are not persisted separately: a failed run always emits exactly one final failure with `eventKind: "workflow_end"`, using the journal text only as a fallback when the final result has none. On the command path, evidence warnings and failures to persist the final digest remain correctly leveled `warning` notifications. A `result.json` write failure already belongs to the final live/typed result and is not repeated as a toast. If `waitForIdle`, the final idle check, or `sendMessage` is unavailable or fails, the digest is not sent and a clear warning is shown; the persisted journal/result artifacts remain source truth. The fallback never calls `sendMessage` and therefore cannot steer the parent agent.

The compact workflow panel fits to the terminal height, keeps its journal internally, and shows the workflow/run header, the declared/reached/current stage frontier, one current or recent leaf row, bounded diagnostics, and the `/ps` inspection hint. It does not publish or expand the global fleet selection. Every `agent_end` status is terminal in the projection: `completed`, `failed`, and `cancelled` all leave `active`, atomically clear `currentTools`, `currentToolArgs`, and `currentToolStartMs`, freeze `elapsedMs`, stop the spinner, and render their own marker. Drill therefore cannot retain a stale command such as `sleep 60`, and duration cannot keep growing after cancel. Live-row settlement alone does not decide the workflow outcome: a bare result remains script-controlled, while a result returned directly from a `parallel()` branch or `pipeline()` stage with `status: "failed" | "blocked" | "cancelled"` becomes typed group failure after the barrier. Those rows participate in the shared fleet, but bare `Up`/`Down` always remain Pi editor/history input; `/ps` opens fleet management and `Shift+Down` is the registered fallback. Aggregate group rows remain visible status headings and are never selectable or actionable; in focused mode, `Enter`, `/ps last`, and direct targets operate only on exact leaf rows. Workflow leaf rows are inspectable but never keyboard-stoppable. `x` asks for confirmation only for a selected standalone working SDK child through its live `AbortController` seam. Terminal rows keep drill/back but expose no `x stop` affordance.

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

The row renderer is the shared local `AgentLivePanel` (`extensions/_shared/agent-live-panel.ts`),
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
by `/workflows run`: scan-based Project/User discovery plus the curated Package
registry. It does not add a separate UI-only registry. Every current row
is one selectable two-line block: the first line shows the compact badge, human
source label (`Project`, `User`, or `Package`), name, and one-line description;
the second line indents the exact origin path under the content column. A path
that still exceeds the terminal width is middle-truncated so its beginning and
basename remain visible. Current and History stay adjacent when the terminal has
spare rows; unused height remains below the lists instead of splitting them.
Very low terminals use a compact one-line fallback.
History rows are separate evidenced runs, not a deduplicated list of names: each
row carries its own `runId`, persisted target, source label, and retained snapshot
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

The action bar is deliberate prompt handoff, not execution. `Tab` cycles the
visible actions and Enter activates only the focused action. Focus is marked by
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
`Request: ...`, `Skill: $pi-workflow-authoring`, and
`Additional instructions:` handoff because those actions require source work.
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

Bare `/workflows` first reopens the oldest actionable handoff. When no such
handoff is pending, it clears stale workflow chrome and installs a typed `VIEW`
with catalog, information, history, and run commands. Passive `/workflows list`,
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
Escape inside an operator question similarly dismisses only that question: it
does not abort an agent, cancel a workflow, mutate source evidence, or consume
the queue item.
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
   cat .test_pi/.locus/runtime/workflows/<runId>/result.json
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
 * @param {import("../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {string | undefined} input
 */
export default async function runWorkflow(dsl, input) {
  // PyCharm/WebStorm can now navigate agent(), phase(), log(), and other DSL methods.
}
```

Adjust the relative type path for a nested workflow. This comment performs no
runtime import and does not change source-identity coverage.

### Workflow diagram contract

Use `$pi-workflow-diagram` when a workflow has multiple execution steps, agents,
branches, parallel groups, or persisted handoffs. Every
curated Package workflow must keep three sibling artifacts beside
`<name>.workflow.mjs`:

- `<name>-pipeline.diagram.mjs` — reproducible Excalidraw.js generator.
- `<name>-pipeline.excalidraw` — editable diagram with embedded assets.
- `<name>-pipeline.png` — visually reviewed preview.

The diagram is an ownership map, not a decorative code trace:

- Prefix each executable or data node with exactly one real owner/type:
  `Operator:`, `Workflow:`, `Agent:`, or `Artifact:`. (`Direct LLM:` was a fifth
  owner before 0.2.x; the primitive and its diagram vocabulary are now removed.)
- A branch must say who produced the decision and who routes it. A text-only
  `agent()` result is not implicit decision data: show the exact text handoff,
  and show a deterministic workflow check only when trusted workflow code
  actually validates something. Do not use ownerless labels such as
  `Target ready?`.
- Name workflow control explicitly: `Workflow: launch Agents 2 + 3 in parallel`
  and `Workflow: wait for both lane results`, not `fan-out` or `barrier` alone.
- Label important edges with the actual handoff. For text-only agents, name the
  exact string such as `targetText` or `implementationText`; for a schema-bearing
  call (`agent({ schema })`), name the schema and inspected field.
- Show the source `<name>.workflow.mjs`, the persisted
  `.locus/runtime/workflows/<runId>/result.json`, `journal.ndjson`, and artifact
  index when they record meaningful execution evidence. Draw runtime-owned
  Markdown as a separate artifact when `publishArtifact()` or
  `agent({ artifact })` really persists it. The review family therefore shows
  `review.md`, per-finding answers, independent check evidence, and `re-review.md`
  under the run artifact store rather than a task-local publication surface.
- Include a legend that explains the visual types and any accent colors. A
  reader must understand the graph without opening the workflow source.

Generate through `@kroffske/excalidraw-diagrams`, keep a fixed `Scene` seed, run
`assertDiagramHealthy(...)`, validate the serialized Excalidraw document, render
the PNG, and inspect the image itself. Do not hand-write raw Excalidraw element
JSON. Repository tests enforce the artifact trio and the minimum ownership /
persistence vocabulary; visual inspection remains required because structural
validation cannot prove that a diagram is readable.

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
  const workerText = await agent(`Task: ${task}. Use a read tool once, then return a concise Markdown answer.`, {
    agent: "quick_task",
    label: "work",
    permissionMode: "agent-defined",
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
- Use `promptFile("./resources/name.prompt.md", variables)` when a stage needs
  substantial workflow-specific instructions or dynamic handoffs. Keep the
  stable role and the per-run task in that one prompt. The path is
  source-relative and hash-backed. Runtime policy such as `readOnly`, `tools`,
  and `workspaceMode` remains visible in the `agent()` options.
- `agent()` is the only model-calling step. For a **cheap one-shot decision**
  (a gate, a classification, a draft), reuse a catalog agent constrained to a fixed
  answer shape — `agent(prompt, { schema, tools: [], maxToolCalls: 0 })` — instead of
  reaching for a second primitive. The common useful shape is agents-in-a-loop with a
  judge that breaks the loop on its `verdict`, optionally fronted by a cheap shaped
  gate. The pattern catalog contains an inline skeleton.

### Declared phases — `meta.phases`

A run's shape is otherwise only knowable by executing it, because phases are
declared imperatively by `phase()` calls inside the body. Optional `meta.phases`
states the pipeline up front, and it is read by the same bounded catalog scan
that already extracts `description` — first 64 KiB, AST only, module never
imported or evaluated:

```js
export const meta = {
  name: "review",
  description: "Prepares clarification or runs a read-only question-led review with runtime-owned artifacts.",
  phases: [
    { title: "prepare-clarification", detail: "Persist exact intent and prepare questions." },
    { title: "consume-clarification", detail: "Verify prior-run refs and persist answers." },
    { title: "resolve-scope", detail: "Turn exact intent and clarification into one review scope." },
    { title: "inventory-changes", detail: "Prove complete coverage of the changed surface." },
    { title: "plan-units", detail: "Group the inventory into atomic units of meaning." },
    { title: "ask-questions", detail: "Write falsifiable questions without answering them." },
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

To turn a plain-text requirement into a valid `<name>.workflow.mjs`, delegate to the
`workflow-author` catalog agent rather than hand-authoring: `/agent run workflow-author`
or `task { agent: "workflow-author", task: "<requirement>" }`. It writes the file to
the canonical `.pi/workflows/`, confirms the module loads (`meta` + default export), and
returns the path. This page is its detail reference. The helper is a catalog agent only;
the package surface remains `./extensions/workflows/index.ts`.

---

## DSL surface (v0)

```ts
agent(prompt, opts?)          // Run a catalog/local agent; returns exact child text
agent(prompt, {schema, …})    // Same child run under a declared shape; returns the VALIDATED value
publishArtifact(name, text)   // Persist workflow-authored text; return full digest-bound reference
consumeTextArtifact(ref)      // Verify/copy prior-run text; return current ref + exact text
captureSourceState(label)     // Persist host-owned Git HEAD/index/worktree fingerprint evidence
awaitOperator({reason})       // Declare a successful operator handoff without changing result
promptFile(path, variables?)  // Render a neighboring .prompt.md resource
workspace(label, ref)         // Allocate one retained workspace; returns opaque handle
projectRoot()                 // Absolute launch project root
parallel(thunks)              // Full barrier; success returns ordered T[], ordinary failed branches reject typed evidence
pipeline(items, ...stages)    // Per-item staged chains; a failed item stops before its later stages, then typed reject
phase(name)                   // Progress grouping + journal line
log(msg)                      // Journal line
now()                         // Recorded wall clock (ms); replayed on --resume
random()                      // Recorded randomness in [0,1); replayed on --resume
```

`awaitOperator()` accepts exactly one non-empty compact reason of at most 200
characters. It is a control declaration, not model output and not a thrown
pause. Call it only after durable handoff artifacts exist, immediately before
returning the unchanged handoff payload. An abort or semantic/infrastructure
failure still wins at finalization.

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

| Field             | Type                      | Default                                                                | Description                                                                                                                                                                          |
| ----------------- | ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`           | string                    | `"default"`                                                            | Catalog name from `.agents/agents/`; pass `"quick_task"` explicitly for the mechanical worker path                                                                                   |
| `readOnly`        | `true`                    | selected catalog agent value                                           | Per-call host-enforced narrowing. It cannot turn a catalog read-only agent into a writer.                                                                                            |
| `tools`           | string[]                  | selected agent allow-list                                              | Per-call subset of the selected catalog agent's tools. Use `[]` for a no-tool child. A request outside the catalog allow-list fails policy validation.                               |
| `maxToolCalls`    | non-negative safe integer | `1000`                                                                 | Per-child-attempt runaway safety fuse. `0` requires a no-tool completion. The first over-budget tool start aborts the child; this is not a normal work target or security boundary.  |
| `label`           | string                    | —                                                                      | Journal / UI label                                                                                                                                                                   |
| `artifact`        | string                    | safe label or agent name                                               | Logical name for the exact automatic answer artifact. It must be a safe single component; transcript/result names derive from it.                                                    |
| `phase`           | string                    | current phase                                                          | Overrides the active phase tag                                                                                                                                                       |
| `permissionMode`  | string                    | `"inherit-parent"` for bare default agent, otherwise `"agent-defined"` | Permission intent: `"inherit-parent"`, `"agent-defined"`, or `"restricted"`. This is trace metadata, not a security boundary.                                                        |
| `workspaceMode`   | string                    | `"project"`                                                            | Workspace intent: `"project"`, `"worktree"`, or `"temporary-worktree"`. Worktree modes allocate an isolated git worktree for file-change review UX.                                  |
| `workspaceHandle` | string                    | —                                                                      | Opaque handle returned by `workspace(label, ref)`; reuses one runtime-owned linked worktree across agent calls.                                                                      |
| `sandbox`         | string                    | —                                                                      | Deprecated alias. `"read-only"` maps to `workspaceMode: "project"`; `"workspace-write"` maps to `workspaceMode: "worktree"`. Explicit `permissionMode` / `workspaceMode` fields win. |
| `model`           | string                    | current session model                                                  | Per-call selector `provider/id[:thinking]`. A resolved selector is passed to the child session; if absent or unresolved, the workflow agent bridge currently supplies `ctx.model`.   |
| `schema`          | object (JSON Schema)      | none                                                                   | **Opt-in.** Declare the answer shape: the call returns the validated value instead of text, retries up to `SCHEMA_MAX_ATTEMPTS`, and throws `SchemaValidationError` on exhaustion.   |

`agent()` resolves to exact non-empty text. The runtime persists that text before
emitting terminal `agent_end`; fresh sessions also contribute their transcript
and result envelope. Child metadata and diagnostics stay in journal/result
evidence; model text is never parsed as status or JSON unless the call opted into
`schema`.

The host may replace the default agent fuse through
`WorkflowRuntimeOptions.defaultMaxToolCalls`; an explicit per-call value wins.
There is no small authoring ceiling such as the former 100-call cap.

### Opt-in shaped answers — `agent({ schema })`

The default above is the contract for every stage that hands work to the next
stage as prose. `schema` is the explicit exception, for the stages that need a
decision rather than a paragraph — a yes/no gate, a small fixed field set:

```js
const gate = await agent(await promptFile("resources/gate.prompt.md", { diff }), {
  agent: "reviewer",
  readOnly: true,
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
   `additionalProperties:false`, and `items`; unsupported types/keywords and
   malformed or misplaced declarations fail with zero child calls.
2. Appends a deterministic shape block (the JSON Schema plus "one JSON value,
   no prose") to the prompt the child receives.
3. Runs the child exactly as an ordinary `agent()` call — same catalog agent,
   same capability options, same live row, same `agent_start`/`agent_end` lines.
4. Parses the child's final text as JSON (a `json` code fence is tolerated) and
   validates it with the DSL's JSON-Schema subset validator:
   `type` (object/array/string/number/boolean), `required`, `properties`,
   `additionalProperties:false`, `items`, `enum`.
5. On mismatch, retries with a fresh child whose prompt carries the previous
   attempt's validator errors, up to `SCHEMA_MAX_ATTEMPTS` (2) child runs total.
6. Resolves to the validated value, or throws `SchemaValidationError` carrying
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
(`{status: "valid"|"mismatch", attempts, errors}`) on its own `agent_end`
journal line, so a run's evidence shows whether a stage was shape-checked and
how many tries it took. Each attempt is a real child run and counts against
`maxTotalAgentInvocations`; a call without `schema` counts exactly once, as
before.

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
  tools: [], // no-tool child — nothing to call, so nothing to wait for
  maxToolCalls: 0,
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

**Budget.** Each child run records token/cost `usage` on its `agent_end` journal line;
`/workflows status` sums it per run (`tokens=… cost=$…`). Observational only — there
is no hard cap.

---

## Approval / trust discipline

- **Permissions:** `permissionMode` describes the child run's tool-policy intent (`"inherit-parent"`, `"agent-defined"`, or `"restricted"`). It does not allocate a worktree.
- **Tools:** `tools` can only narrow the selected catalog agent's allow-list. It cannot grant a tool that the agent definition excludes.
- **Read-only agents:** `readOnly: true` in `agent()` options, or on the selected
  catalog definition when no per-call override is present, is enforced by the
  SDK host. The child receives only `read`, `grep`, `find`, `ls`, `yield`, and
  package-owned bounded tools such as `git_read`, `ast_index`, or
  `repository_check` when explicitly requested. `repository_check` accepts only
  a baseline `package.json` script name while the complete scripts map remains
  byte-for-byte equivalent to its pre-writer capture; added `pre`/`post` hooks,
  removals, and command changes are refused. It runs with host-owned argv in a
  disposable external Git worktree; it does not expose arguments or shell text.
  Initialized gitlinks are recursively overlaid with their current tracked and
  untracked source bytes, without copying submodule Git administrative metadata.
  `bash`, `write`, `edit`, nested
  `workflow`, and unknown tools are removed. `git_read` accepts argv for
  allowlisted Git queries and rejects mutation, output-file, external-diff,
  textconv, pager, signature, and config options before launch.
- **Workspace:** `workspaceMode: "project"` keeps the child in the current project working directory. `workspaceMode: "worktree"` and `"temporary-worktree"` make the bridge create a retained git worktree under `.locus/runtime/workflows/<runId>/worktrees/<call-id>/`, then pass that path as `AgentRunRequest.workingDirectory`.
- **Deprecated alias:** `sandbox: "read-only"` maps to `workspaceMode: "project"`; `sandbox: "workspace-write"` maps to `workspaceMode: "worktree"`. Existing workflows still run and receive a deprecation diagnostic. New workflows should use `permissionMode` and `workspaceMode`.
- Pi native approval policy owns whether the underlying write-tier calls are allowed, prompted, or denied.
  The worktree isolates file changes for diff UX purposes, but it is not a security boundary.

---

## Fail-closed behavior

When the Pi SDK host cannot spawn a child agent session:

1. `createAgentSdkSessionExecutor` returns `status: "blocked"` with `diagnostics` containing `AGENT_SDK_UNAVAILABLE_DIAGNOSTIC`.
2. `workflow-agent-bridge.ts` detects that token and throws `WorkflowAgentUnavailableError` with the honest `AGENT_SDK_UNAVAILABLE_HINT` ("Pi SDK host") reason.
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
prompt, the catalog `agent`, `readOnly`, `tools`, `maxToolCalls`, `model`,
`label`, `phase`, `permissionMode`, `workspaceMode`, and any `workspaceHandle`.
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
.locus/runtime/workflows/<runId>/
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
    published/       — Text written through publishArtifact()
    inputs/          — Verified copies consumed from prior runs, with source refs
```

`agent_end` carries `usage` (token/cost), the resolved `model`, and — for a shaped call —
`schemaValidation`, plus full answer/transcript/result artifact references when
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
Each definition's frontmatter supplies the system prompt, allowed tools,
permission metadata, and optional `model` preference. The current bundled catalog
includes `default`, `designer`, `explore`, `librarian`, `local_file_worker`,
`oracle`, `plan`, `quick_task`, `reviewer`, `task`, and `workflow-author`; project
or user definitions may shadow these names.

### Model selection: execution versus metadata

The runtime has two different model paths:

- `agent(prompt, { model: "provider/id[:thinking]" })` resolves that explicit
  selector through `getModel` and, when successful, passes the resolved model to
  the new child session. If the selector is absent or does not resolve, the
  current implementation supplies the parent session's `ctx.model`.
- Without a per-call selector, the chosen agent's frontmatter `model` is resolved
  as model-role metadata. Direct `provider/id[:thinking]` values become an agent
  assignment; role names use the effective role order `session` → Pi settings →
  project config → user config and fall back across `agent`, `task`, then
  `default`. This `modelRoleResolution` is recorded in the request capsule,
  artifacts, and live display. In the current workflow bridge it does not replace
  the executor's `ctx.model`; it is provenance/routing metadata unless a per-call
  `opts.model` is supplied.

`meta.description` has no effect on any of these choices. `/workflows info`
reports the rules but never resolves them into a claimed future execution graph.

---

## Default package

`workflows` is registered in `package.json#pi.extensions` and loads by default; the
`/workflows` command and `workflow` tool are available without manual loading.
See [docs/extension-ownership-matrix.md](../../extension-ownership-matrix.md) for the full status.
