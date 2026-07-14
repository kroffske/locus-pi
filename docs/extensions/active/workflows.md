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

A Pi-native dynamic-workflow runtime that provides a DSL (`agent / llm / parallel / pipeline / phase / log`) for orchestrating `.agents` catalog sub-agents through the existing `task / createAgentSession` path, plus a direct model-call node.

Two ways a workflow reaches a model:

- **`agent()`** — spawns a full `.agents` catalog child session (tools, structured-result protocol), routed through the same code path as the `task` tool.
- **`llm()`** — makes ONE direct model completion via the pi-ai host (`completeSimple` / `streamSimple`), with no child session and no tools. Use it for cheap classify/summarize/synthesis nodes where a full agent is overkill. See "Direct model calls" below.

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

| Seam | Location | Status |
|---|---|---|
| Bounded concurrency | `extensions/_shared/workflow-runtime.ts` `runScheduled()` | DONE (per-call). `parallel()`/`pipeline()` run through a bounded worker pool (`SCHEDULER_WIDTH = 4`) that preserves input ordering. Width bounds each `runScheduled` call, not globally. A **global limiter** + width tuning remains a future scheduler task. |
| Git-worktree isolation | `workflow-agent-bridge.ts`, `workflow-worktree.ts` | DONE for `workspaceMode: "worktree"` / `"temporary-worktree"`: each isolated agent gets a retained `.locus/runtime/workflows/<runId>/worktrees/<call-id>/` git worktree before child execution. Merge-back remains out of scope. |
| Trusted script execution | `extensions/_shared/workflow-runner.ts` `loadWorkflowScript()` | Author scripts are **reviewed trusted input**. Default `self-contained-static` restricts declared module edges for identity evidence; explicit `entry-only` keeps full modular Node.js access. Neither mode isolates capabilities. A real isolate is a future seam, not current protection. |
| Owner-default agent + model routing | `extensions/_shared/workflow-runtime.ts`, `workflow-agent-bridge.ts`, `.agents/agents/default.md` | DONE. Bare `agent(prompt)` resolves to catalog agent `default`; explicit `agent(prompt, { agent: "quick_task" })` keeps the mechanical worker path. Model routing keeps per-call `opts.model` precedence, keeps agent frontmatter `model` visible in the request capsule through model-role resolution, and otherwise lets the child executor use the current session model fallback. |

---

## Curated Package workflows

| Workflow | What it is |
|---|---|
| `live-smoke` | Minimal **live proof**: 2 read-only agents each do one small tool action and report. Cheap (~2 agents). Run it to confirm the host can actually spawn child agents; verify via `result.json`. |
| `llm-smoke` | Minimal **live proof of `llm()`**: 4 direct model calls (plain, system-prompt, streamed, schema=) — no child agent sessions. Run it to confirm the host can make a direct model completion; verify real text + `classified.output` in `result.json` and `llm_start`/`llm_end`/`llm_delta` in `journal.ndjson`. |
| `requirements-grill` | Read-only **requirements refinement**: requires ripgrep (`rg`) on `PATH`. The trusted workflow script runs `rg` directly with fixed arguments, sanitized request keywords, a 10-second timeout, and 200-line/40,000-character result caps. Three no-tool default children then map, challenge, and synthesize explicit structured handoffs from that artifact. Empty input fails at `validate-input`; missing `rg` fails closed at `collect-context`; `repositoryContext`, stage evidence, and the final handoff are retained in `result.json`. |

These three names form the Package registry. They are intentionally small and
owned as part of the package product surface, not discovered merely because a file
exists in `extensions/workflows/examples/`.

## Authoring patterns

The clean release contains no uncurated Package examples. The pattern catalog
`extensions/workflows/references/patterns.md` provides inline skeletons that an
operator may save under a reviewed project or user workflow directory. Saving a
local workflow does not add it to the Package registry.

For *which shape to pick* (single-agent, llm()-gate, loop+judge, plan→build→review,
pipeline, fan-out+merge, judge-panel, loop-until-dry), see the pattern catalog
`extensions/workflows/references/patterns.md` — it maps each requirement to a minimal
skeleton to adapt. Only the three workflows in the curated table
above are registered Package workflows. (Single source: that file is the catalog of
*forms*; this doc remains the DSL *contract*.)

Saved workflow names such as `live-smoke` use one first-wins resolver for
execution, `/workflows list`, and `/workflows info <name>`. Starting at the command's
working directory and walking upward to the project root, each level is checked in this
order:

1. `./.pi/workflows/<name>.workflow.mjs` — human source `Project`; the canonical
   Pi-native authoring target.
2. `./.claude/workflows/<name>.workflow.mjs`, then
   `./.agents/workflows/<name>.workflow.mjs` — human source `Project`; interoperability
   inputs that may use a different workflow format.
3. `~/.pi/workflows/<name>.workflow.mjs` — human source `User`.
4. The curated Package registry — human source `Package`; currently `live-smoke`,
   `llm-smoke`, and `requirements-grill`.

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
/workflows                        typed command view; clears stale workflow widget
/workflows run live-smoke         run a workflow (live progress panel)
/workflows run live-smoke --resume <runId>  link a new run to a prior persisted workflow summary
/workflows list                   current first-wins workflows + run-specific immutable history
/workflows list <query>           filter catalog by name or description
/workflows info                   explain discovery, metadata, trust, DSL, agents, and model routing
/workflows info <name>            add exact first-wins source/path and static meta.description
/workflows status                 bounded recent runs with total/shown/older summary
/workflows status <runId>         bounded newest journal rows + result artifact pointer
```

Every run is persisted to `.locus/runtime/workflows/<runId>/` (`journal.ndjson`
while running, `result.json` when finished), so `status` works across sessions and
after the fact.

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

Pi 0.80.3 can invoke an extension command immediately while the parent agent is still streaming. Therefore `/workflows run` first checks the real command context `ctx.isIdle()` before target resolution, transcript creation, or workflow execution. A busy session fails closed with `Workflow not started: Pi is busy streaming…`; it sends no custom message and starts no workflow. The operator retries after the current response finishes. Read-only `/workflows list` and `/workflows status` do not create transcript messages and remain available. This guard is required because `sendMessage({ triggerTurn:false })` routes to `agent.steer()` when Pi is streaming, despite `triggerTurn:false`.

When the command runs, `/workflows run` installs one live progress panel below the input (`belowEditor`). Its transient key is pinned while execution is active, so unrelated input cannot remove live work. Compact workflow activity is contributed as owner `workflow.run` to the shared `status:locus` registry; the registry bounds the combined footer to 48/28/16 columns instead of creating a competing private status key. After completion the panel/status/transient presentation remains available for the current host cycle, then the next non-empty `input`, registered command cleanup, or Pi `turn_end` removes that large presentation. Store-owned cleanup retains the newest five workflow run subtrees whose rows are all terminal so `/ps` viewer, `/ps last`, and direct leaf guidance remain available; older fully terminal subtrees are pruned. Active, queued, and zero-row runs are never counted or pruned, and other agent rows stay intact. This lifecycle uses Pi's documented [`input`/`turn_end` events](https://pi.dev/docs/latest/extensions#events) and [`setWidget(key, undefined)` cleanup](https://pi.dev/docs/latest/extensions#widgets-status-and-footer), not a timer.

Transcript persistence follows the Pi surface that started the run. The slash-command path does not call `sendMessage` for start or intermediate events, because a long workflow can outlive the launch-time idle check. It keeps the bounded lifecycle in memory while widget/status surfaces show live progress. After the workflow finishes and the completion UI is updated, the command awaits the real `ctx.waitForIdle()`, rechecks `ctx.isIdle()`, and immediately writes one visible digest through `pi.sendMessage({ customType: "locus-workflow-event", display: true, ... }, { triggerTurn: false })`. There is no await between the final idle check and the send call, so Pi's synchronous routing appends instead of steering. The call omits `deliverAs` and does not start or queue a model turn. The one digest is stored and participates in later LLM context.

The programmatic `workflow` tool never calls `sendMessage` while its tool output may be streaming. It buffers the same lifecycle and appends one digest to the single ordinary final `toolResult` text; Pi therefore persists it through the native tool-call transcript without an extra turn. Streamed progress updates remain presentation-only. Both paths cap each line at 160 characters and keep at most 20 agent transitions plus start/final, so a digest has at most 22 lifecycle lines and 4096 characters. Raw result/journal detail never enters the digest. Workflow agent lines use the stable catalog `agent` plus `label` and status, not the workflow parent-row petname: the live panel may collapse that parent in favour of an SDK child with a different canonical petname. Terminal markers are status-aware: `✓ … finished` only for `completed`, `⊘ … cancelled` for `cancelled`, and `✗ … failed` for `failed`. Journal `error` lines are not persisted separately: a failed run always emits exactly one final failure with `eventKind: "workflow_end"`, using the journal text only as a fallback when the final result has none. On the command path, evidence warnings and failures to persist the final digest remain correctly leveled `warning` notifications. A `result.json` write failure already belongs to the final live/typed result and is not repeated as a toast. If `waitForIdle`, the final idle check, or `sendMessage` is unavailable or fails, the digest is not sent and a clear warning is shown; the persisted journal/result artifacts remain source truth. The fallback never calls `sendMessage` and therefore cannot steer the parent agent.

The panel fits to the terminal height, keeps its journal internally, and its header shows current `phase`, active count, total terminal count, and separate cancelled/failed counts before the detailed rows. Every `agent_end` status is terminal in the projection: `completed`, `failed`, and `cancelled` all leave `active`, atomically clear `currentTools`, `currentToolArgs`, and `currentToolStartMs`, freeze `elapsedMs`, stop the spinner, and render their own marker. Drill therefore cannot retain a stale command such as `sleep 60`, and duration cannot keep growing after cancel. Live-row settlement alone does not decide the workflow outcome: a bare result remains script-controlled, while a result returned directly from a `parallel()` branch or `pipeline()` stage with `status: "failed" | "blocked" | "cancelled"` becomes typed group failure after the barrier. Those rows participate in the shared fleet, but bare `Up`/`Down` always remain Pi editor/history input; `/ps` opens fleet management and `Shift+Down` is the registered fallback. Aggregate group rows remain visible status headings and are never selectable or actionable; in focused mode, `Enter`, `x`, `/ps last`, and direct targets operate only on exact leaf rows. `x` asks for confirmation before aborting only the selected working SDK child through its live `AbortController` seam. Terminal rows keep drill/back but expose no `x stop` affordance.

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
summaries such as completed/failed counts while preserving individual agent and
`llm()` rows.

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
typed intent from the custom component. The `/workflows` command awaits
`ctx.ui.custom()` completion, restores Pi's main editor, and only then calls
`setEditorText()` once with a compact `Request: ...`,
`Skill: $pi-workflow-authoring`, and optional `Additional instructions:` prompt.
The request contains the exact current path or historical run/snapshot identity;
the skill owns the Start, Edit, Review, and unavailable-snapshot procedures. The
browser does not submit the prompt. No browser path calls the workflow runner,
imports a module, writes a file, mutates history, sends a message, or claims
success if the editor setter is missing or fails.

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
parsed `meta.description`; an unknown name fails explicitly.

In an interactive Pi TUI with custom UI support, the command opens that complete
block in a workflow-owned read-only scroll view. Up/Down moves one line,
PgUp/PgDn moves one page, Home/End jumps to the first/final page, and Esc/q
closes the view. Tests reconstruct every rendered semantic line at
146, 80, and 48 columns. RPC, print/no-UI, and TUI hosts without custom UI keep
the same bounded passive projection; the TUI fallback says that interactive
scrolling is unavailable. Neither projection imports or runs a workflow,
invents an execution graph, mutates the editor, or writes a file. This focused
view is not a generic fix for `Ctrl-O`, `cat`, or terminal scrollback.

Bare `/workflows` clears stale workflow chrome and installs a typed `VIEW` with
catalog, information, history, and run commands. Passive `/workflows list`,
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

- `export const meta = { name, description }` — catalog metadata only. `name`
  should match the saved file's `<name>` so it resolves by bare name;
  `description` appears in `/workflows list` and `/workflows info <name>`. Metadata
  does not declare the execution graph, agents, permissions, or runtime model.
- `export default async function runWorkflow(dsl, input) { ... }` — executable
  behavior. `dsl` is the intended authoring handle; `input` is the free-text
  `[input]` from the run command (a string, possibly empty). Whatever the function
  returns is written to `result.json` as `result`. Trusted JavaScript can still use
  host capabilities allowed by its identity mode, so `dsl`-only is a convention,
  not enforcement.

Destructure the primitives you need from the first arg:

```js
const { agent, llm, phase, log, parallel, pipeline, workflow } = dsl;
```

### Minimal working template

One real agent that does a tool action and returns a schema-checked result:

```js
// hello.workflow.mjs
export const meta = {
  name: "hello",
  description: "One agent lists the cwd and returns a schema-checked verdict.",
};

const SCHEMA = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const task = (typeof input === "string" && input.trim()) || "list the cwd";

  phase("work");
  const worker = await agent(
    `Task: ${task}. Use a read tool once to list the current directory ` +
      `(a real tool action). Then return ONLY the structured result envelope: ` +
      `end with LOCUS_AGENT_RESULT_V1 followed by JSON ` +
      `{ "version": "locus.agent.result.v1", "status": "completed", ` +
      `"summary": "<one line>", "output": { "ok": true } }.`,
    { agent: "quick_task", label: "work", permissionMode: "agent-defined", schema: SCHEMA },
  );
  log(`worker ok=${Boolean(worker?.ok)} session=${worker?.childSessionId ?? "none"}`);

  return {
    ok: Boolean(worker?.ok && worker?.output?.ok === true),
    childSessionId: worker?.childSessionId ?? null, // proves a real spawn
    output: worker?.output ?? null,
  };
}
```

Notes:
- Keep `meta.description` as one concise, purpose-first sentence: name the useful
  outcome, not test evidence, implementation detail, or a long execution trace.
  Use a literal static string near the top of the module. The browser scans only
  the first 64 KiB, accepts no interpolation/computed value, and shortens catalog
  display after 96 characters. Project and user workflows are never rewritten by
  the browser.
- An `agent()` step that opts into a `schema` should end its message with the
  structured envelope (`LOCUS_AGENT_RESULT_V1` + JSON, `output` carries the schema'd
  value). Plain-text completion still works when no `schema` is set.
- Choose `agent()` when the step must **do tool work** or be an authoritative judge
  whose verdict is a real child session; choose `llm()` for a **cheap one-shot
  decision / text** (a gate, a classification, a draft) with no tools and no session.
  The common useful shape is agents-in-a-loop with a judge that breaks the loop on its
  `verdict`, optionally fronted by a cheap `llm()` gate. The pattern catalog contains
  an inline skeleton.

### What is NOT supported

- **No arbitrary inline JS through the `workflow` tool.** The tool is trusted-file
  only: a saved `name` or a project-relative `scriptPath` (`script` is a legacy alias
  that normalizes to one of those). To run ad-hoc logic, save a `.workflow.mjs` first.
- **No custom primitives / event kinds / lifecycle states.** The DSL surface below is
  the whole contract; do not invent a primitive the runtime does not expose.
- **Use `dsl` only as an authoring policy.** Reach the filesystem/model through
  `agent()` (tools) or `llm()` (direct model) in reviewed workflows. This is not
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
or `task { agent: "workflow-author", tasks: ["<requirement>"] }`. It writes the file to
the canonical `.pi/workflows/`, confirms the module loads (`meta` + default export), and
returns the path. This page is its detail reference. The helper is a catalog agent only;
the package surface remains `./extensions/workflows/index.ts`.

---

## DSL surface (v0)

```ts
agent(prompt, opts?)          // Run a catalog agent (child session); returns WorkflowAgentResult
llm(prompt, opts?)            // ONE direct model completion (no session/tools); returns WorkflowLlmResult
parallel(thunks)              // Full barrier; success returns ordered T[], ordinary failed branches reject typed evidence
pipeline(items, ...stages)    // Per-item staged chains; a failed item stops before its later stages, then typed reject
phase(name)                   // Progress grouping + journal line
log(msg)                      // Journal line
```

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

| Field | Type | Default | Description |
|---|---|---|---|
| `agent` | string | `"default"` | Catalog name from `.agents/agents/`; pass `"quick_task"` explicitly for the mechanical worker path |
| `tools` | string[] | selected agent allow-list | Per-call subset of the selected catalog agent's tools. Use `[]` for a no-tool child. A request outside the catalog allow-list fails policy validation. |
| `maxToolCalls` | integer 0–100 | none | Per-child-attempt call budget. The first over-budget tool start aborts the child and returns a failed result; this is a workflow budget, not a security boundary. |
| `label` | string | — | Journal / UI label |
| `phase` | string | current phase | Overrides the active phase tag |
| `permissionMode` | string | `"inherit-parent"` for bare default agent, otherwise `"agent-defined"` | Permission intent: `"inherit-parent"`, `"agent-defined"`, or `"restricted"`. This is trace metadata, not a security boundary. |
| `workspaceMode` | string | `"project"` | Workspace intent: `"project"`, `"worktree"`, or `"temporary-worktree"`. Worktree modes allocate an isolated git worktree for file-change review UX. |
| `sandbox` | string | — | Deprecated alias. `"read-only"` maps to `workspaceMode: "project"`; `"workspace-write"` maps to `workspaceMode: "worktree"`. Explicit `permissionMode` / `workspaceMode` fields win. |
| `model` | string | current session model | Per-call selector `provider/id[:thinking]`. A resolved selector is passed to the child session; if absent or unresolved, the workflow agent bridge currently supplies `ctx.model`. |
| `schema` | object (JSON Schema) | none | JSON Schema the agent output must satisfy; enables schema-validation retry loop (see Schema enforcement below) |
| `throwOnSchemaMismatch` | boolean | `false` | When `schema` is set, throw `SchemaValidationError` on final mismatch instead of returning `ok:false` |

### Schema enforcement

When `opts.schema` is provided, the runtime validates `result.output` after each attempt. It retries up to `SCHEMA_MAX_ATTEMPTS` times, currently `2`.

On final mismatch, behavior depends on `opts.throwOnSchemaMismatch`:

- **default (`false`)** — a bare `agent()` returns a result object with `ok:false`, `status:'failed'`, a `schema mismatch` diagnostic and `schemaValidation: { status:'mismatch', attempts, errors }`. It does not throw. Callers MUST guard on `r.ok` before using `r.output`. When that result is returned directly from a `parallel()` branch or `pipeline()` stage, the group rejects `WorkflowGroupFailureError` after siblings settle; the failed value remains inspectable in `slots` and `partialResults`.
- **`throwOnSchemaMismatch: true`** — `agent()` throws `SchemaValidationError` (carrying `.errors` and `.attempts`). A bare `agent()` call rejects. Inside `parallel()` / `pipeline()`, the group records it as a `kind: "thrown"` branch failure and rejects `WorkflowGroupFailureError` after siblings settle. Use it for fail-fast bare callers.

Each retry is a fresh agent run (a complete-but-wrong structured result cannot be resumed), not a continued session.
Successful schema calls carry `schemaValidation: { status:'valid', attempts, errors:[] }`, so a workflow can audit recovery after more than one infrastructure attempt without counting it as more than one domain-quality verdict. Raw child/model failure is not relabelled as schema-valid or schema-mismatch, and no-schema calls omit the field. Terminal `agent_end`/`llm_end` journal lines carry the same value.

The supported JSON-schema subset is `type` (`object`, `array`, `string`, `number`, `boolean`), `required`, `properties`, `additionalProperties: false`, `items` (array element schema), and `enum`.

---

## Direct model calls — `llm()`

`llm(prompt, opts?)` makes ONE direct model completion through the pi-ai host
(`completeSimple`, or `streamSimple` when `opts.stream`). It does **not** spawn a child
agent session and passes **no tools** — it is the cheap path for classify / summarize /
synthesize nodes. It funnels through the same bounded scheduler seam as `agent()`.
Before either pi-ai call, the bridge asks `ctx.modelRegistry.getApiKeyAndHeaders(model)`
for the selected model's API key, provider/model headers, and provider environment,
then passes that request auth to `completeSimple` / `streamSimple`. This matches Pi's
own direct-provider call boundary; using `ctx.model` alone is not sufficient for OAuth
or registry-backed credentials.

Returns a `WorkflowLlmResult`: `{ ok, text, stopReason, model?, usage?, output?, diagnostics, label?, schemaValidation? }`.
`ok` is true when the model returned normally (`stopReason` `stop`/`length`).

`opts` for `llm()`:

| Field | Type | Default | Description |
|---|---|---|---|
| `system` | string | — | Maps to `Context.systemPrompt` |
| `model` | string | session model | Per-call selector `"provider/id[:thinking]"`; resolved via the same `getModel` path as `agent()`, else `ctx.model` |
| `reasoning` | string | — | Provider thinking level (`minimal`/`low`/`medium`/`high`/`xhigh`) |
| `stream` | boolean | `false` | Use `streamSimple`; emits an `llm_delta` journal line per text chunk (live rows in the progress panel) |
| `schema` | object (JSON Schema) | none | Parse `result.text` as JSON and validate against this schema (retry up to `SCHEMA_MAX_ATTEMPTS`); a valid value is returned in `result.output` |
| `throwOnSchemaMismatch` | boolean | `false` | Throw `SchemaValidationError` on final mismatch instead of returning `ok:false` |
| `label` / `phase` | string | — | Journal / UI label; phase tag |

**Model and host permissions.** Because `llm()` calls the model directly in-process,
the manifest declares `models: true`. Separately, trusted workflow JavaScript can
use network-capable Node builtins or explicitly downgraded installed modules, so manifest filesystem,
subprocess, network and browser fields are conservative `*`/enabled declarations.
Those fields describe possible host capability; they do not add a DSL primitive.

**Fail-closed.** No model resolved, request-auth resolution failed, a model/network
error, or a final schema mismatch returns `ok:false` with diagnostics — never a fabricated
completion, never a throw into the script (except the opt-in `throwOnSchemaMismatch`).
The first failed-call diagnostic is retained on `llm_end`, shown by status/detail, and
used as the final workflow receipt fallback when the script returns only `ok:false`.
Parser and validator exhaustion is typed as
`schemaValidation.status:'mismatch'`; model/network failure is not. When such a result is
returned directly from a `parallel()` branch or `pipeline()` stage, it becomes typed group
failure after the barrier.

**Budget.** Each `llm()` records token/cost `usage`; `/workflows status` sums it per run
(`tokens=… cost=$…`). Observational only — there is no hard cap.

---

## Approval / trust discipline

- **Permissions:** `permissionMode` describes the child run's tool-policy intent (`"inherit-parent"`, `"agent-defined"`, or `"restricted"`). It does not allocate a worktree.
- **Tools:** `tools` can only narrow the selected catalog agent's allow-list. It cannot grant a tool that the agent definition excludes.
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

## Journal layout

```
.locus/runtime/workflows/<runId>/
  script-<sha256>.workflow.mjs — Read-only bytes evaluated for this run
  journal.ndjson    — NDJSON lines: {ts, runId, kind, source?, phase?, message?, agent?, usage?, ...}
                      kinds: phase | log | agent_start | agent_end |
                             llm_start | llm_end | llm_delta |
                             group_start | group_end | error
  result.json       — Final result + full journal snapshot + script identity
.locus/runtime/reports/
  agent-sdk-<name>-<stamp>.jsonl  — Per-child SDK session evidence (one per agent() call)
```

`llm()` nodes journal `llm_start` / `llm_end` (the latter carries `usage`, resolved `model`,
and a bounded first diagnostic when failed)
and, when streaming, an `llm_delta` per text chunk. They are counted separately from agents,
so `/workflows status` shows `agents=…` and `llm=…` independently.
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
- `llm(prompt, { model })` is separate. An explicit selector must resolve or the
  call returns `ok:false`; only an omitted selector uses `ctx.model`. `llm()` does
  not use agent catalog definitions or model-role metadata.

`meta.description` has no effect on any of these choices. `/workflows info`
reports the rules but never resolves them into a claimed future execution graph.

---

## Default package

`workflows` is registered in `package.json#pi.extensions` and loads by default; the
`/workflows` command and `workflow` tool are available without manual loading.
See [docs/extension-ownership-matrix.md](../../extension-ownership-matrix.md) for the full status.
