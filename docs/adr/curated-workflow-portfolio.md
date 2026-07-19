# ADR: Curated Package workflow portfolio

- Status: accepted
- Date: 2026-07-17
- Amended: 2026-07-18

## Decision

The Package registry remains a strict allowlist. A workflow is curated only when
it is useful across repositories, has a stable and bounded input/output contract,
produces inspectable evidence, fails closed when evidence is unavailable, and has
a permission posture that the package can support as a public promise.

The accepted Package portfolio is:

| Workflow             | Product role                | Why it belongs                                                                                                                    |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `live-smoke`         | Child-session diagnostic    | It proves the installed host can create real child sessions with a minimal read-only run.                                         |
| `llm-smoke`          | Direct-model diagnostic     | It proves `llm()` routing independently from child-session behavior.                                                              |
| `requirements-grill` | Requirements refinement     | It turns a recurring cross-project intake problem into a bounded structured handoff.                                              |
| `review`             | Evidence-backed code review | It covers a recurring merge gate and publishes immutable evidence plus a separate, all-pending human approval manifest.           |
| `review-fix`         | Isolated accepted fixes     | It applies only explicit human approvals in a retained linked worktree and publishes independent verification without committing. |

`review` keeps review and remediation separate. It is an agent pipeline, not an
evidence adapter. Each workflow owns ordinary `resources/*.agent.md`
definitions and `resources/*.prompt.md` step prompts beside its entry file.
The first full local agent resolves
the target and proves access, two independent agents obtain their own change and
whole-context evidence, and the final agent reopens the target before
adjudicating findings. This design keeps private-forge authentication and
repository operations inside the existing agent/tool environment instead of
creating a second provider-specific integration in the package.

The four inspection agents declare `readOnly: true`. The SDK host turns that
declaration into a capability allowlist: shell, write/edit, nested workflow, and
unknown tools are unavailable. Git inspection uses the package-owned
`git_read` tool, which executes only allowlisted query subcommands without a
shell, pager, external diff, textconv, hooks, fsmonitor, or optional locks.
`permissionMode: "agent-defined"` remains trace intent and Pi still owns
operator approval, but the publisher-only write rule no longer depends on
prompt compliance. The adjudicator returns reader-facing Markdown; a separate
publisher agent writes the complete reader-facing report to
`.tasks/<task>/artifacts/review.md` after proving `.tasks/` is ignored. The same
publisher mechanically copies every verified finding into `fix-plan.md` with
every disposition initially `pending`; it does not add findings or invent a
second implementation plan. Mandatory `result.json` remains technical runtime
evidence rather than the primary report.

Externalizing prompts is an explicit readability trade-off. Both entry modules
declare `identityCoverage: "entry-only"` because their SHA-256 does not bind
neighboring resources; `review-fix` also imports a deterministic local plan
validator. Runtime snapshots each loaded Markdown resource once and records its
SHA-256 instead of pretending the entry hash covers it.

Keeping `review.md` and `fix-plan.md` as separate files preserves the human gate
without a separate `review-plan` workflow. The operator may change individual
findings in the approval manifest to `accepted`, `waived`, or `deferred` without
rewriting review evidence. `review-fix` treats only `accepted` as write
authority. Deterministic code validates file confinement, hashes, target,
snapshot, finding identity, explicit plan edit, and the reviewed commit before
allocating one runtime-owned linked worktree. Implementer and verifier share
one opaque workspace handle. The workflow does not edit the original checkout,
commit, push, create a pull request, merge, or deploy.

## Selection boundary

The following shapes are not curated now:

- Generic plan/build/fix orchestration remains project-local. The curated
  exception is the narrow review family: it has an immutable source report,
  per-finding human dispositions, an exact reviewed snapshot, a mandatory
  linked-worktree boundary, and no commit or remote action.
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
sequence—evidence plus human approval, then isolated fix—while keeping
deployment and publication outside the workflow boundary. Removing a separate
`review-plan` run avoids three redundant agent sessions without weakening the
immutable-report or human-approval boundaries.
