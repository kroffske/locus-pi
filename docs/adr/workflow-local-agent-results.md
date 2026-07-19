# ADR: Text-only agent results and workflow-local Markdown agents

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
definitions and prompts lived in one long YAML document.

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
- `llm({ schema })` keeps its separate explicit JSON validation contract.

A workflow may select either:

- `agent: "name"` for a normal project/user/bundled catalog agent; or
- `agentFile: "./resources/name.agent.md"` for a workflow-local agent.

The two options are mutually exclusive. A workflow-local agent is an ordinary
Markdown agent definition with front matter and body instructions. Concrete
step prompts live in neighboring `*.prompt.md` files and are rendered through
`promptFile(path, variables)`.

Resource paths are resolved from the original workflow entry directory, not
the process working directory or retained script snapshot. Runtime rejects
absolute paths, lexical escapes, symlink escapes, missing files, wrong suffixes,
malformed agents, missing prompt variables, and unused prompt variables. It
reads each source once, writes a read-only run copy, and records source path,
snapshot path, size, and SHA-256.

For a workflow-local definition with `readOnly: true`, the SDK host narrows the
child to known read capabilities. It removes shell, write/edit, nested workflow,
and unknown custom tools. Read-only Git inspection is available through the
package-owned `git_read` argv tool; mutating subcommands and process-spawning
options are rejected before Git starts.

## Review remediation boundary

`review-fix` validates the human-edited plan with deterministic code before any
write-capable child or worktree exists. Runtime creates one linked worktree at
the reviewed commit and returns an opaque handle. Implementer and verifier use
that same handle; model-returned paths are never workspace authority.

## Consequences

Workflow source becomes shorter and handoffs are visible as ordinary text.
Runtime status can no longer be forged by writing `{"status":"completed"}` in a
model answer. Workflows that need structured model output must use an explicit
direct-LLM schema step or implement a separate protocol in a future scoped
change.

The old agent result envelope, `agents.yaml` review loader, agent-side schema
option, batch `tasks:[]` tool shape, and backward-compatibility parser are
removed. This is an intentional breaking change because the current package has
one coordinated consumer.
