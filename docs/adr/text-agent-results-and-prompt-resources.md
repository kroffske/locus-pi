# ADR: Text-only agent results and workflow-local prompt resources

- Status: accepted
- Date: 2026-07-19

## Context

Agent calls previously supported a model-written JSON result envelope with
status, summary, diagnostics, artifacts, and optional schema validation.
Curated review prompts were also stored in one large `agents.yaml` file.

That design mixed two responsibilities:

- the model described its own runtime status;
- orchestration code parsed model text as a transport protocol.

It also made the review workflow hard to read and edit because unrelated agent
definitions and prompts lived in one long YAML document. Splitting that file
into paired `*.agent.md` and `*.prompt.md` resources still left two concepts
for every workflow stage even though only the prompt needed per-run rendering.

## Decision

Every successful agent call returns its exact final non-empty text.

- `spawn_agent` and `task` accept one required `task` string and create one
  child agent.
- Successful `ToolResult.content` is the exact child text.
- `dsl.agent()` resolves to the exact child text.
- JSON-looking text remains text. Agent calls do not parse a marker, envelope,
  status, summary, paths, ids, diagnostics, artifacts, or schema.
- Empty text and runtime child failures remain technical failures.
- Child session ids, evidence, diagnostics, artifacts, model data, and workspace
  data stay in runtime-owned details, journals, and result envelopes.
- Structured output is an explicit per-call opt-in, never implicit. See the
  2026-07-21 amendment below for the surviving contract, `agent({ schema })`.

A workflow selects a normal project, user, or bundled catalog agent. Omitted
`agent` uses the catalog `default` role. Workflow-specific behavior lives in
one neighboring `*.prompt.md` per stage and is rendered through
`promptFile(path, variables)`. The prompt contains both the stable role
instructions and the concrete per-run handoff.

Runtime policy remains code, not prompt prose. Per-call `readOnly`, `tools`,
`permissionMode`, `workspaceMode`, and `maxToolCalls` options define the child
execution boundary. `readOnly: true` narrows the selected catalog definition
for that call before the SDK host constructs its capability allowlist. It
cannot broaden a catalog read-only agent.

Resource paths are resolved from the original workflow entry directory, not
the process working directory or retained script snapshot. Runtime rejects
absolute paths, lexical escapes, symlink escapes, missing files, wrong suffixes,
missing prompt variables, and unused prompt variables. It reads each prompt
once, writes a read-only run copy, and records source path, snapshot path, size,
and SHA-256.

For a call with `readOnly: true`, the SDK host narrows the selected catalog
agent to known read capabilities. It removes shell, write/edit, nested
workflow, and unknown custom tools. Read-only Git inspection is available
through the package-owned `git_read` argv tool; mutating subcommands and
process-spawning options are rejected before Git starts.

## Review remediation boundary

`review-fix` validates the human-edited plan with deterministic code before any
write-capable child or worktree exists. Runtime creates one linked worktree at
the reviewed commit and returns an opaque handle. Implementer and verifier use
that same handle; model-returned paths are never workspace authority.

## Amendment 2026-07-21 — opt-in `agent({ schema })`

This is the "separate protocol in a future scoped change" the Consequences below
anticipate. The default is unchanged: without `schema`, `dsl.agent()` still
resolves to the child's exact final text and parses nothing.

- `dsl.agent(prompt, { schema })` is an explicit per-call contract. The runtime
  appends a deterministic shape block to the child prompt, validates the child's
  final text against the declared JSON-Schema subset, retries within the shared
  `SCHEMA_MAX_ATTEMPTS` budget, and resolves to the validated value.
- It fails closed: exhausting the budget throws `SchemaValidationError`. A child
  that fails to run still throws `WorkflowAgentExecutionError`.
- Structure remains an author decision, never an implicit protocol. Runtime
  status is still not model-controlled: the schema shapes the answer only, and
  `status`, `summary`, ids, artifacts, and diagnostics stay runtime-owned.
- Validation is journaled per attempt as `schemaValidation` on `agent_end`.

Reason for the amendment: `llm({ schema })` was the only schema-validated path in
the DSL, and it was removed in favour of one model-calling primitive (T-108,
2026-07-21). The shaped path had to exist on `agent()` first, so it landed first.
The subset validator, the JSON extractor, the shared `SCHEMA_MAX_ATTEMPTS` budget,
and `SchemaValidationError` survived the removal and now belong to `agent()` alone.

## Consequences

Workflow source and resources become shorter: every stage has one prompt, while
runtime policy stays visible in the workflow entry. Handoffs remain ordinary
text.
Runtime status can no longer be forged by writing `{"status":"completed"}` in a
model answer. Workflows that need structured model output declare it per call with
`agent({ schema })` (the 2026-07-21 amendment above); there is no second
model-calling surface to reach for.

The old agent result envelope, `agents.yaml` review loader, workflow-local
`agentFile` loader, agent-side schema option, batch `tasks:[]` tool shape, and
backward-compatibility parser are removed. This is an intentional breaking
change because the current package has one coordinated consumer.
