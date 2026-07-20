# Curated review workflow

The package contains two related workflows:

- `review` inspects a target and publishes review evidence;
- `review-fix` applies the findings a human left in that report, after
  revalidating each one against live source.

The core contract is deliberately small:

1. A workflow-specific stage is one neighboring `*.prompt.md` file.
2. The prompt contains both stable role instructions and dynamic
   `{{VARIABLE}}` handoffs.
3. `agent(renderedPrompt, options)` launches a catalog agent. Omitted `agent`
   uses the catalog `default` role.
4. Capability policy remains in workflow code. `readOnly`, `tools`,
   `workspaceMode`, and `maxToolCalls` are not prompt claims.
5. A successful child returns exact non-empty text. The workflow forwards that
   text without `JSON.parse`, result schemas, or model-written envelopes.

## Files

```text
extensions/workflows/examples/
├── review/
│   ├── README.md
│   ├── review.workflow.mjs
│   ├── review-pipeline.diagram.mjs
│   ├── review-pipeline.excalidraw
│   ├── review-pipeline.png
│   └── resources/
│       ├── scope-resolver.prompt.md
│       ├── change-inventory.prompt.md
│       ├── unit-planner.prompt.md
│       ├── interrogator.prompt.md
│       ├── verifier.prompt.md
│       └── publisher.prompt.md
└── review-fix/
    ├── review-fix.workflow.mjs
    ├── review-fix-input.mjs
    ├── review-fix-pipeline.diagram.mjs
    ├── review-fix-pipeline.excalidraw
    ├── review-fix-pipeline.png
    └── resources/
        ├── scope-resolver.prompt.md
        ├── unit-planner.prompt.md
        ├── implementer.prompt.md
        ├── verifier.prompt.md
        └── publisher.prompt.md
```

There are no workflow-local `*.agent.md` files. Catalog agents provide the
stable execution mechanism; neighboring prompts provide workflow-specific
behavior.

## How one stage is launched

```js
const prompt = await promptFile("./resources/change-inventory.prompt.md", {
  SCOPE_TEXT: scopeText,
});

const text = await agent(prompt, {
  ...REVIEW_READ_OPTIONS,
  label: "inventory changes",
});
```

`promptFile()` resolves the path from the original workflow entry, not from the
process working directory. Runtime rejects absolute paths, lexical and symlink
escapes, missing files, wrong suffixes, missing variables, and unused
variables. It reads each prompt once, stores an immutable run copy, and records
SHA-256 evidence.

`REVIEW_READ_OPTIONS` and `REVIEW_NAVIGATE_OPTIONS` are declared once near the
top of `review.workflow.mjs`. The 1,000-call limit is a runaway fuse, not a
normal budget. `workspaceMode: "project"` keeps inspection in the launch
checkout. `readOnly: true` causes the SDK host to remove shell, write/edit,
nested workflow, and unknown tools. Git inspection uses the allowlisted
`git_read` argv tool.

The three stages that reason about code relationships also get `ast_index`, an
allowlisted argv tool over the installed `ast-index` binary. Query commands and
the cache-only `update`/`rebuild` are allowed; `clear`, `watch`, unknown
commands, and output-file options are rejected. The index database lives in the
user cache directory, so refreshing it never touches reviewed source. When the
binary or index is unavailable, the prompts fall back to `grep`/`find` and
record the gap; a missing AST Index never blocks a review.

## Where `phase()` and `log()` come from

Workflow entry files do not import DSL methods at runtime. Pi passes one `dsl`
object as the first argument to `runWorkflow`.

- `WorkflowDsl` is defined in
  `extensions/_shared/workflow-runtime.ts`.
- `phase(name)` changes the visible stage and appends a `phase` journal line.
- `log(message)` appends a script-owned message under the current stage.
- The JSDoc type link above `runWorkflow` lets JavaScript-aware IDEs navigate
  from destructured DSL methods to `WorkflowDsl` without executing an import.

## Agent map

```mermaid
flowchart LR
    U["Operator: review request"]

    subgraph R["Workflow: review"]
        R1["Agent R1: resolve review scope<br/>read-only"]
        R2A["Agent R2a: inventory changes<br/>read-only"]
        R2B["Agent R2b: plan review units<br/>read-only + ast_index"]
        R3["Agent R3: ask falsifiable questions<br/>read-only + ast_index"]
        R4["Agent R4: verify and write review<br/>read-only + ast_index"]
        R5["Agent R5: publish review package<br/>write-capable"]

        R1 -->|"exact scopeText"| R2A
        R2A -->|"exact inventoryText"| R2B
        R2B -->|"exact unitsText"| R3
        R3 -->|"exact questionsText"| R4
        R4 -->|"exact reviewText"| R5
    end

    U --> R1
    R5 -->|"review.md + supporting artifacts"| H["Human: edit or delete findings"]

    subgraph F["Workflow: review-fix"]
        V["Workflow: confine path, require findings"]
        F1["Agent F1: resolve fix scope<br/>read-only"]
        F2["Agent F2: revalidate and plan fix units<br/>read-only + ast_index"]
        F3["Agent F3: apply fix units<br/>write-capable"]
        F4["Agent F4: verify and write report<br/>shell, no edit"]
        F5["Agent F5: publish fix package<br/>write-capable"]

        V --> F1
        F1 -->|"exact scopeText"| F2
        F2 -->|"exact unitsText"| F3
        F3 -->|"exact implementationText"| F4
        F4 -->|"exact reportText"| F5
    end

    H -->|"explicit review.md path"| V
```

## `review` algorithm

Six sequential stages. No branching, no parallel barrier, no loop, no fan-out.
Each stage receives the exact previous text; the workflow never parses it.

### 1. R1 resolves the scope

The workflow renders `scope-resolver.prompt.md`. R1 inspects Git state and
repository guidance and turns the free-form request into one explicit
`# Review Scope` with target, includes, excludes, and focus, or one blocked
scope with a single rerun instruction. It returns no hashes or snapshot.

Later stages receive `scopeText` instead of the operator conversation, so the
scope has to stand alone.

### 2. R2a inventories the change

R2a owns coverage, not meaning: it maps every changed surface, including
staged, unstaged, and untracked work, and batches generated or mechanical
changes instead of dropping them. Its `# Change Inventory` becomes
`inventoryText`.

### 3. R2b plans review units

R2b groups the inventory into material decisions. Several files that implement
one decision form one unit; one file with two unrelated decisions becomes two.
Each unit carries one or more `Path:` lines, an optional `Anchor:`, and a
`Change:` sentence. `Anchor:` is a navigation hint — a symbol, heading, config
key, CLI flag, schema property, test case, or workflow stage — never an
identifier the runtime parses.

### 4. R3 asks falsifiable questions

R3 asks the smallest set of questions that could change acceptance, as
`## U<n>-Q<m>` blocks. Several questions per unit are normal. Documentation
questions are conditional: they appear only when the unit changes a public
signature, user-visible behavior, a CLI/API/config/schema contract, or a
workflow already described in the docs, and only about documents that exist.

### 5. R4 verifies and writes the review

R4 treats units as a work map and questions as hypotheses. It reopens the
changed code, direct callers, tests, configuration, and existing documentation,
answers every question exactly once, and promotes only confirmed problems to
findings. Its `# Code Review` records reviewed scope, verdict, findings,
question resolutions, and explicit coverage limits.

### 6. R5 publishes and presents

R5 is the only write-capable review session. It first proves `.tasks/` is
ignored, then creates one local review task and publishes the handoffs as
Markdown: `review-scope.md`, `review-inventory.md`, `review-units.md`,
`review-questions.md`, and the mandatory `review.md`.

R5 may repair presentation — headings, broken Markdown, identifier consistency,
file boundaries — but must not invent, delete, or soften a finding, re-review
the code, or edit source. Its final text is the executive summary the operator
reads: verdict, counts, and every created path. The summary is the workflow
result, not a file.

## Human approval

The operator reads `review.md` and edits it directly. Deleting a finding
rejects it; a free-form note under a finding is an instruction to the fix
workflow. There are no dispositions, hashes, or snapshots to maintain.

Remediation is always a separate, explicitly started workflow. Nothing in
`review` grants write authority over source.

## `review-fix` algorithm

`review-fix` mirrors the `review` shape: interpret intent, plan, act, verify,
present. Five sequential agents follow one deterministic gate, and each stage
receives the exact previous text.

The operator passes the edited `review.md` path, optionally wrapped in ordinary
words such as `apply only the P1 items in .tasks/T-1/artifacts/review.md`.

### 1. Deterministic input confinement

`review-fix-input.mjs` extracts the one `review.md` token from the request and
proves what a prompt cannot: the path is project-relative, lives in a task
`artifacts` directory, resolves without a symlink escape, and its `## Findings`
section still lists at least one `### <id>` block. A review whose findings the
operator deleted throws before any agent exists, and two different `review.md`
paths in one request are rejected rather than guessed.

It validates no hashes, snapshot, disposition, or reviewed commit. `review.md`
is meant to be edited, and the reviewed work is often uncommitted, so there is
nothing immutable to bind to.

### 2. F1 resolves the fix scope

The scope resolver reads the request and the edited report and decides which
remaining findings this run addresses, under which constraints, and which
repository checks matter. It also records whether the working tree already
carries unrelated uncommitted work. Later stages receive `scopeText`, not the
operator conversation.

### 3. F2 revalidates and plans fix units

The unit planner reopens each in-scope finding against the code as it is now.
The code may have moved, been fixed already, or never had the described defect;
`Path:` and `Anchor:` are navigation hints, not addresses. Findings that no
longer hold are listed under `## Stale findings`. The survivors are grouped into
atomic fix units — one coherent change each, ordered by dependency — with the
risk and the check that would catch it.

### 4. F3 applies the units

The implementer applies the planned units in order in the operator's launch
checkout, runs the checks named in the scope, and states which units it skipped
and why. It fixes nothing the plan did not ask for.

### 5. F4 verifies and writes the report

The verifier treats `implementationText` as a claim, reopens the working-tree
diff and affected files, reruns the checks, and writes the complete
`# Fix Report`. It reports any diff hunk no unit asked for. This stage keeps a
shell so it can run tests, so it is not host-enforced read-only; its no-edit
rule is a prompt rule plus Pi approval.

### 6. F5 publishes and presents

The publisher writes `fix-scope.md`, `fix-units.md`, and the mandatory
`fix-report.md` beside the review, repairing presentation only, and returns the
executive summary as the workflow result.

All fix stages work in the operator's launch checkout, not in a worktree,
because the review may cover staged, unstaged, or untracked work that exists in
no commit. Changes stay uncommitted so the operator reviews them as an ordinary
diff.

## Output and safety boundaries

- Model output is always text. Runtime status, diagnostics, session ids, model
  data, and artifacts remain runtime-owned evidence.
- `llm({ schema })` is the separate direct-model JSON contract; `agent()` does
  not parse JSON.
- `readOnly: true` is host-enforced capability narrowing. The `review-fix`
  verifier deliberately does not set it, because running repository checks
  needs a shell; a shell can write, so its no-edit rule is prompt-level.
- `permissionMode` is trace intent, and Pi still owns operator approval.
- `review-fix` edits the launch checkout. Its boundaries are the explicit
  operator start, the deterministic input gate, revalidation of every finding
  before a change, prompt prohibitions on commit, push, merge, deploy, and
  discarding foreign uncommitted work, and the fact that every change stays
  uncommitted.
- Prompt restrictions guide write-capable sessions but do not replace host
  approval or deterministic validation.
