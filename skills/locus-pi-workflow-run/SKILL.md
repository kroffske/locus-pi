---
name: locus-pi-workflow-run
description: Run, start, execute, launch, or resume an existing locus-pi workflow, monitor that current run, and recover a run that stopped, failed, or was interrupted when only its run id is known. Use the native `workflow` tool inside Pi; outside Pi invoke `/workflows run` through `pi --mode json -p` and follow typed receipts and journal paths. Not for creating workflows or browsing unrelated run history.
---

# Run a locus-pi workflow

Run an existing reviewed workflow through the host that already owns model,
authentication, session, child-agent, and evidence lifecycle. Do not add a
wrapper, ask a parent model to call the tool, or import the workflow runner.

Workflow JavaScript is trusted code with full Node.js access in the Pi host. It
is not sandboxed. Project approval is a broad Pi trust decision, not approval of
one workflow file.

## First action: choose by capability

1. If the request supplies `items` or `continuation`, require a structured tool
   named `workflow`. The external slash-command grammar cannot carry those
   fields; stop as unsupported when that tool is unavailable. Never drop them.
2. If a structured tool named `workflow` is available, use the native Pi path.
3. Otherwise, if the `pi` executable is available and the locus-pi package is
   installed, use the external Pi path.
4. Otherwise stop with the missing prerequisite and the install command:
   `pi install npm:@kroffske/locus-pi`.

Tool availability wins; do not guess from the host product name. Require one
exact saved workflow name or project-relative `.workflow.mjs` path. A request to
create or redesign a workflow belongs to `locus-pi-workflow-create` instead.

## Native Pi path

Call the `workflow` tool directly. Supply exactly one of `name` or `scriptPath`:

```json
{
  "name": "review",
  "input": "Review the current diff",
  "outputDir": "tmp/review-current"
}
```

Pass optional exact work units through `items`. `resumeFromRunId` continues an
earlier run from where it stopped, reusing its recorded agent answers and nothing
else; it is not a general "retry the failed run" switch, so choose it only
through the procedure in "Recover a stopped run". Use `continuation` only for an
operator-approved answer
to a recorded handoff. Do not spawn `pi`, build a slash-command, or call a shell
when this tool exists. Read the returned run id, paths, disposition, result, and
artifacts from the tool result.

For any workflow, `runName: "<name>"` selects `.locus-pi/workspaces/<name>`. An
existing legacy-only `.locus-pi/plans/<name>` remains bound in place so its
checkpoint identity does not change. If both paths exist, launch fails closed. Do not
combine `runName` with `outputDir`.

The native tool uses the current Pi session model. It has no per-run model
field. When the operator requests another main model, select it with Pi's
`/model` command and set reasoning with `/effort` before calling `workflow`.

## Inspect model configuration

Model choice belongs to the operator. Do not recommend, assign, or replace a
provider, model, thinking level, or workflow role merely because a workflow is
being launched. When the request does not name a model, preserve the current Pi
session and its configured defaults.

List the models Pi can currently resolve before using an explicit selector:

```bash
pi --list-models
pi --list-models <provider>
```

Pi's persistent main-model settings and hard allowlist live in
`~/.pi/agent/settings.json`. When `jq` is available, inspect the relevant
values without changing them:

```bash
jq '{defaultProvider, defaultModel, defaultThinkingLevel, enabledModels}' \
  ~/.pi/agent/settings.json
```

An explicit `--model <provider/model>` must resolve in `pi --list-models` and
must be permitted by `enabledModels` when that allowlist is configured. Never
remove, add, or replace an allowlist entry unless the operator requested that
exact configuration change.

Workflow child roles have one persistent source:
`~/.pi/agent/model-roles/config.json`. A role assignment uses
`provider/model[:thinking]`. Project `.pi/model-roles/config.json`, Pi
`settings.json#modelRoles`, and session evidence do not override this file.

A model-less child with no assigned `agent` role inherits the live main session
model; assigning `default` does not replace that inheritance. Supplying
`--model` and `--thinking` on an external launch overrides the main model for
that Pi process only. It does not override an explicit workflow child role.

## External Pi path

Invoke Pi in JSON print mode with the slash-command itself as one argv element:

```bash
pi --mode json -p --no-session --approve \
  '/workflows run review -- Review the current diff'
```

Prefer a process API with an argv array:

```text
["pi", "--mode", "json", "-p", "--no-session", "--approve", prompt]
```

When model selection is part of the request, place `--model
<provider/model>` and `--thinking <level>` before `prompt`. These flags select
the main Pi model and its reasoning level for that process. They do not override
assigned workflow child roles.

Build `prompt` as `/workflows run <target> [options] [--] [input]`. Format every
command value token—`target`, `runName`, `outputDir`, and `resumeFromRunId`—the same way:
keep a simple token unchanged; encode values containing whitespace, quotes,
backslashes, or controls as a JSON string token. Reject a command-token value
whose first character is `-`: quoting does not make Pi's reserved option tokens
valid. `outputDir` must stay inside the project; an absolute path is accepted,
`./path` resolves from Pi's working directory, and another relative path resolves
from the project root. `runName` must be one safe folder name. It is mutually
exclusive with `outputDir`. The
`resumeFromRunId` must be a real saved run id. Preserve semantic input unchanged
after `--`. Never interpolate untrusted target, option value, or input as shell
syntax.

Canonical grammar:
`/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]`.

`--approve` trusts project-local settings, packages, extensions, prompts, and
other Pi resources. Use it only for a project the operator has authorized.

## Read the JSON stream

Pi emits both `message_start` and `message_end` for a custom message. Interpret
only records matching all of:

```text
type == "message_end"
message.role == "custom"
message.customType == "locus-workflow-run"
```

Then branch on `message.details.eventKind`:

- `workflow_start` — capture `runId`, `runDir`, `journalPath`, and `resultPath`.
  Require this or `workflow_rejected` within 30 seconds. Keep the Pi process
  attached and read/tail `journalPath` when the caller needs liveness.
- `workflow_rejected` — stop and report its typed `code`, `target`, and message.
  No workflow started.
- `workflow_end` — use `workflowStatus` and `resultPersisted` as terminal truth,
  then read `resultPath` for the final envelope. The exact prose result, when
  present, is emitted before this terminal receipt as `locus-workflow-result`.

Pi may exit `0` after a typed rejection or failed workflow command. Never use
the process exit code alone as semantic success. If no start/rejection receipt
arrives within 30 seconds, if a parent `agent_start` or assistant turn begins,
or if required fields are missing, fail as a protocol error and do not parse
model prose as a fallback.

An `awaiting_operator` terminal status is not permission to answer. Report the
run id, question/artifacts, and required operator action; continue only after an
explicit answer. Timer or spinner changes are presentation, not evidence of new
activity—the durable journal is the activity record.

## Recover a stopped run

A run that failed, was interrupted, or ended without a usable result is
recovered here, starting from its `runId` alone. Read the evidence, declare one
outcome, then act on the declared outcome.

### Read the evidence in this order

Read the run's own files. The `workflow` tool schema has no `status` operation,
so `/workflows status <runId>` is the equivalent operator surface for the same
content, not something an agent can call.

1. `.locus-pi/runs/<runId>/runtime/result.json` — terminal status, `target`,
   `scriptIdentity`, and the `replay` envelope of the stopped run.
2. `failureDiagnostic` inside that file — `origin` (`script` or `runtime`),
   `stage`, `scriptPath`, `evidencePath`, `journalPath`, and one copyable
   `repairRequest`. An absent field means the run never proved it.
3. The failing stage's answer at `evidencePath`, when the run persisted one.
   This is the text that states why the stage rejected the work.
4. `.locus-pi/runs/<runId>/runtime/journal.ndjson` — the append-only lifecycle
   record. Its `replay:` line states whether the stopped run was recorded
   (`replay: not recorded reason=…` means no later run can resume from it).
5. The replay record of the stopped run,
   `.locus-pi/runs/<runId>/runtime/replay.ndjson`. Each recorded agent line
   carries a `node` naming the call as `[phase, label, occurrence]`, so the
   question "which nodes already finished" is answered from the record alone,
   without reading the workflow source and without inverting a request hash. A
   line with no `node` was written before node names existed.

### Declare one outcome before launching

Name `continue` or `refuse` before starting anything, then prove that outcome
from the new run's evidence afterwards.

- `continue` — launch the same target with `resumeFromRunId` (operator surface:
  `--resume <runId>`). Editing the stopped workflow first is allowed and
  expected: repair is the point. The completed prefix is reused, the repaired
  node runs fresh, and so does the tail after it. Changed source bytes no longer
  end a resume.
- `refuse` — one of the cases below holds. Report it by name with the run id and
  the required operator action; do not launch a run that cannot honor the
  declared outcome.

What reuse costs and requires:

- Replay serves recorded answer text only. It does not re-create files, re-read
  the project, or repeat any child side effect. Reuse is correct only while the
  workspace and project tree still contain what the replayed calls wrote. A
  cleaned workspace turns a replayed "checks passed" answer into a false green.
- After the source is repaired, a recorded call is reused only when the record
  names its node and the current call carries the same name. A call the author
  never labeled cannot be located in a program that changed under it, so it runs
  fresh and takes the rest of the run with it.
- The first fresh call ends reuse for the whole run. Every later call runs fresh
  too, including calls whose own prompt did not change: their recorded answers
  came from a run where the repaired node behaved differently.
- A `fusion()` group standing after that point does not run fresh. It ends the
  run with `fusion resume cannot mix recorded and fresh agent calls`. Split the
  panel out, or accept a fully fresh run. The same boundary costs one case that
  used to work: a byte-identical resume no longer replays a fusion tail that sat
  after a recorded failure.

A resume runs in the workspace of the source run. When that workspace was
selected explicitly, repeat it with `outputDir` (operator surface:
`--run-name <name>` for a stable `.locus-pi/plans/<name>` workspace). Omitting
it or passing a different path fails closed instead of creating a new
workspace silently.

### Prove the outcome after the run

Read the `replay` envelope of the NEW run's `runtime/result.json`:
`replayedCalls` counts what was reused, and `divergedAtNode` names the node
where continuation became fresh. `freshCalls` alone proves nothing — a full
restart reports it too. Confirm on disk that the files the replayed answers
describe are still there.

### Refuse, by name

1. The run is unreadable: no `.locus-pi/runs/<runId>/`, or `result.json` is
   missing or corrupt.
2. The source journal says `replay: not recorded` — that run can never be
   resumed; only a fresh run remains.
3. `scriptPath` resolves outside the current `projectRoot`, for example an
   installed Package workflow. Do not edit an installed tree; ask for a
   project-owned copy or an upstream fix.
4. The original semantic input is unavailable. The raw launch request is not
   persisted, so an unreproducible input means a declared fully fresh run or
   this refusal — never a guessed input.
5. The terminal status is `awaiting_operator`. That run needs a real operator
   answer through `/workflows continue <runId>`; it is not a recovery route and
   the answer must never be synthesized.
6. The workspace or project tree changed since the source run, so replayed
   answers would describe files that no longer exist.
7. Resume was requested without the source workspace, or with a different one.
8. The stopped run was recorded before node names existed, or its calls carry no
   `label`, and the source must be repaired. Every call then misses with
   `unnamed-node` and the continuation is a fresh run under another name. Say so
   instead; the next run records names and is recoverable.

### Delegate the source edit

Repairing the stopped workflow needs an edited `.workflow.mjs` or `.prompt.md`.
That work belongs to the `locus-pi-workflow-create` skill, which owns authoring
shape and the `workflow_check_source` validation — including the rule that every
`agent()` call carries a unique literal `label`. Hand the diagnostic and the
failing answer to it, then return here to continue the same run id.

## Return to the caller

Report the resolved target, terminal status, `runId`, `journalPath`,
`resultPath`, primary result/artifact, and any required operator action. Do not
claim completion when the terminal receipt is missing or says otherwise.

Bad: `pi -p "Please call the workflow tool to run review"` — this asks a model
to choose and invoke the workflow.

Good: call `workflow` directly when available; otherwise send the literal
`/workflows run ...` command to Pi JSON print mode and follow its typed receipts.
