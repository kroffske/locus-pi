---
name: locus-pi-run-workflow
description: Run, start, execute, launch, or resume an existing locus-pi workflow and monitor that current run. Use the native `workflow` tool inside Pi; outside Pi invoke `/workflows run` through `pi --mode json -p` and follow typed receipts and journal paths. Not for creating workflows or browsing historical runs.
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
create or redesign a workflow belongs to `locus-pi-workflows` instead.

## Native Pi path

Call the `workflow` tool directly. Supply exactly one of `name` or `scriptPath`:

```json
{
  "name": "review",
  "input": "Review the current diff",
  "outputDir": "tmp/review-current"
}
```

Pass optional exact work units through `items`, retry a failed run through
`resumeFromRunId`, and use `continuation` only for an operator-approved answer
to a recorded handoff. Do not spawn `pi`, build a slash-command, or call a shell
when this tool exists. Read the returned run id, paths, disposition, result, and
artifacts from the tool result.

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

Build `prompt` as `/workflows run <target> [options] [--] [input]`. Format every
command value token—`target`, `outputDir`, and `resumeFromRunId`—the same way:
keep a simple token unchanged; encode values containing whitespace, quotes,
backslashes, or controls as a JSON string token. Reject a command-token value
whose first character is `-`: quoting does not make Pi's reserved option tokens
valid. `outputDir` must already be a safe project-relative path, and
`resumeFromRunId` must be a real saved run id. Preserve semantic input unchanged
after `--`. Never interpolate untrusted target, option value, or input as shell
syntax.

Canonical grammar:
`/workflows run <name|path> [--output-dir <path>] [--resume <runId>] [--] [input]`.

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

## Return to the caller

Report the resolved target, terminal status, `runId`, `journalPath`,
`resultPath`, primary result/artifact, and any required operator action. Do not
claim completion when the terminal receipt is missing or says otherwise.

Bad: `pi -p "Please call the workflow tool to run review"` — this asks a model
to choose and invoke the workflow.

Good: call `workflow` directly when available; otherwise send the literal
`/workflows run ...` command to Pi JSON print mode and follow its typed receipts.
