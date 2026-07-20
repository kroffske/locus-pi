# ADR: Curated Package workflow portfolio

- Status: accepted
- Date: 2026-07-17
- Amended: 2026-07-20

## Decision

The Package registry remains a strict allowlist. A workflow is curated only when
it is useful across repositories, has a stable and bounded input/output contract,
produces inspectable evidence, fails closed when evidence is unavailable, and has
a permission posture that the package can support as a public promise.

The accepted Package portfolio is:

| Workflow             | Product role                | Why it belongs                                                                                                                     |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Child-session diagnostic    | It proves the installed host can create real child sessions with a minimal read-only run.                                          |
| `llm-smoke`          | Direct-model diagnostic     | It proves `llm()` routing independently from child-session behavior.                                                               |
| `requirements-grill` | Requirements refinement     | It turns a recurring cross-project intake problem into a bounded structured handoff.                                               |
| `review`             | Evidence-backed code review | It covers a recurring merge gate and publishes a readable, question-resolved report a human can edit directly.                     |
| `review-fix`         | Human-directed fixes        | It applies the findings a human left in that report, revalidating each against live source, and verifies the result independently. |

`review` keeps review and remediation separate. It is an agent pipeline, not an
evidence adapter. Each workflow owns ordinary `resources/*.prompt.md` step
prompts beside its entry file. Each prompt contains the stable stage role plus
the dynamic per-run handoffs. Six sequential child sessions resolve the review
scope from free-form operator intent, inventory the changed surface, group it
into material review units, ask falsifiable questions, independently reopen the
evidence to answer them, and publish the package. Questions are hypotheses:
only what the verifier confirms from re-read evidence becomes a finding. This
design keeps private-forge authentication and
repository operations inside the existing agent/tool environment instead of
creating a second provider-specific integration in the package.

The five inspection calls set `readOnly: true` in workflow code. The SDK host
turns that per-call policy into a capability allowlist: shell, write/edit,
nested workflow, and unknown tools are unavailable. Git inspection uses the package-owned
`git_read` tool, which executes only allowlisted query subcommands without a
shell, pager, external diff, textconv, hooks, fsmonitor, or optional locks. The
three stages that trace code relationships also receive `ast_index`, an
allowlisted argv tool over the installed `ast-index` binary whose database lives
outside the reviewed project; it degrades to `grep`/`find` instead of blocking a
review. `permissionMode: "agent-defined"` remains trace intent and Pi still owns
operator approval, but the publisher-only write rule no longer depends on
prompt compliance. The verifier returns reader-facing Markdown; a separate
publisher agent publishes the review package to `.tasks/<task>/artifacts/` after
proving `.tasks/` is ignored, with `review.md` as the mandatory primary report
and the stage handoffs as supporting artifacts. The publisher may repair
presentation but may not invent, delete, or soften a finding. Mandatory
`result.json` remains technical runtime evidence rather than the primary
report; the workflow result itself is the publisher's executive summary.

Externalizing prompts is an explicit readability trade-off. The workflow uses
catalog agents and does not define neighboring workflow-local agents. `review`
imports nothing and keeps the default `self-contained-static` identity, so the
runner executes its retained snapshot; only `review-fix` declares
`identityCoverage: "entry-only"`, because it imports a deterministic local input
validator whose bytes its entry hash cannot bind. Identity coverage never
covered prompts either way: runtime snapshots each loaded prompt once and
records its SHA-256 instead of pretending the entry hash covers it.

The human gate is `review.md` itself, edited in place. Deleting a finding
rejects it, rewording one changes the request, and a note under a finding
instructs the fix agents. This replaces the earlier `fix-plan.md` disposition
manifest and its hash, snapshot, and reviewed-commit binding, which could not
express a review of uncommitted work — the common case for "review what I have
right now". `review-fix` therefore validates only what a prompt cannot: path
confinement and a non-empty finding list, before any write-capable child exists.
Its five agents mirror the review shape — scope, units, apply, verify,
publish — run in the launch checkout for the same reason, revalidate each
finding against live source before changing anything, and leave every change
uncommitted; they do not commit, push, create a pull request, merge, deploy, or
discard uncommitted work they did not create.

## Selection boundary

The following shapes are not curated now:

- Generic plan/build/fix orchestration remains project-local. The curated
  exception is the narrow review family: it has one readable source report, an
  explicit human edit as the approval signal, a deterministic input gate before
  any write-capable child, per-finding revalidation against live source, and no
  commit or remote action.
- Release and deploy workflows remain project-local because providers,
  credentials, rollback, and blast radius are not package-neutral.
- Incident-response workflows remain project-local because infrastructure access
  and evidence sources vary by operator environment.
- A future `test-triage` workflow is a candidate only after it has a
  language-neutral target contract, bounded logs, and proof that it adds value
  beyond ordinary repository commands.

Repository or user workflow files remain the proving ground for new shapes.
Existence under an examples directory does not promote a workflow; registry,
tests, package allowlist, manuals, support boundary, and changelog must change
together.

## Consequences

The Package surface grows from three to five names, but not into a general
automation catalog. The two review-family names expose one deliberate
sequence—question-led evidence, then a human-directed fix—while keeping
deployment and publication outside the workflow boundary.

Dropping the hash-bound approval manifest is a real trade. The package no
longer proves that the fixed code is byte-identical to the reviewed code; it
proves instead that a human chose which findings survived and that an agent
rechecked each one against the code as it is now. That fits a review of
uncommitted work, which the previous contract could not address at all, and it
removes a bookkeeping layer that weak models handled badly. The remaining
guardrails are deliberate and small: deterministic path confinement, a
non-empty finding list before any write-capable child, and changes that stay
uncommitted for ordinary diff review.
