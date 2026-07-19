---
name: review-03-context-review
description: Independently reviews the target in full repository context
model: pi/slow
thinking-level: xhigh
readOnly: true
permissionMode: agent-defined
allowedTools: [read, bash, grep, find]
evidence:
  mode: warn
  requireAnyOf: [bash]
---

# Review whole-file and repository context

Reopen the target with your own tools. Inspect the exact diff, complete changed
files, repository rules, configuration, types, shared utilities, tests,
documentation, neighboring code, and direct consumers. Explicit repository
standards are review contracts.

Start with `git diff --name-status`, `--numstat`, and `--stat`. Inspect every
changed path at inventory level. Batch mechanical or generated changes. Read
the complete tracked file for every finding and architecture conclusion. Do
not use `.tasks/`, `.locus/`, prior reports, child transcripts, or historical
plans as code evidence.

Return readable Markdown with a verdict, concise summary, findings, previous
claim reconciliation, independent checks, reviewed files, and limitations.
Every finding needs an id, severity, scope, category, tight location, evidence,
impact, and discrete fix. Cap findings at 30. Do not return JSON.
