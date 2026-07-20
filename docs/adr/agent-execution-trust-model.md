# ADR: Agent execution trust model

Status: accepted

## Context

This ADR records the trust model for child agents, workflow scripts, evidence,
and local security checks in `locus-pi`.

It exists because the package exposes agent execution through `extensions/agents/`
and local orchestration through `extensions/workflows/`, while some security
work remains in `extensions/beta/security-gate/`. The decision here is about the
current product contract, not a future sandbox design.

## Permissions

By default, a child agent inherits the parent session's rights. This is
intentional for the current `extensions/agents/` execution model: the child is a
delegated agent inside the same trusted Pi run, not a separately sandboxed
principal.

The boundary still validates local agent-run policy such as depth, turn budget,
and allow-list data before spawning through the Pi host, but it does not reduce
the parent Pi permissions into a smaller child permission set.

## Completion contract

A general agent may finish without tool calls. It is **not required to call
tools**.

Successful completion requires a real non-empty child answer. Tool activity,
structured markers, and extra workload proof may be evidence when an agent
profile asks for them, but they are not a universal requirement for every
general agent run.

## Evidence

Evidence expectations are set by the agent profile and by the specific execution
path. Extension ownership and review status are indexed in the
[ownership matrix](../extension-ownership-matrix.md); executable evidence is
named by each extension manifest's `tests` field.

For example, a profile can require visible tool activity, a structured marker,
or a particular artifact. A different profile can accept a plain answer when the
task does not need tools. The runner must not invent evidence to satisfy a
profile.

## Workflow trust

Workflow `.mjs` files run as trusted local orchestration code through
`extensions/workflows/`. A workflow script is **not** a sandbox.

Workflow launch and tool metadata can ask Pi for approval and can record runtime
journals, but the script itself is local code with the permissions available to
the hosting Pi process and configured workflow runtime.

## Security ownership

Security enforcement is owned by Pi original. The local security layer under
`extensions/beta/security-gate/` is report-only and does not block execution.

`locus-pi` can document risk, expose diagnostics, and delegate approval metadata
to the Pi host. It must not claim that the beta local security layer enforces
global safety policy.

## Explicit answers

Q: Does a general agent have to call tools?
A: No. A general agent may complete without tool calls when its profile does not
require them.

Q: Does a default child agent get all parent rights?
A: Yes, by design. A default child agent inherits the parent session's rights.

Q: Is a workflow script sandboxed?
A: No. A workflow `.mjs` script is trusted local orchestration code, not a
sandbox.

Q: Who is responsible for security enforcement?
A: Pi original. The local beta security gate reports and delegates; it does not
block.

## Status table

| by design                                                      | not supported                                           | planned later                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Default child agents inherit parent session rights.            | Per-child reduced permission sandboxes.                 | Revisit scoped child permissions if Pi exposes a supported host contract. |
| General agents may complete without tool calls.                | Treating tool calls as a universal success requirement. | Profile-specific evidence policies can become more explicit.              |
| Workflow `.mjs` files run as trusted local orchestration code. | Treating workflow scripts as sandboxed code.            | More workflow audit and launch metadata can be added.                     |
| Security enforcement delegates to Pi original.                 | Local beta `security-gate` blocking global execution.   | Promote local security work only after a real blocking contract exists.   |
