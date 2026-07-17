# ADR: Curated Package workflow portfolio

- Status: accepted
- Date: 2026-07-17

## Decision

The Package registry remains a strict allowlist. A workflow is curated only when
it is useful across repositories, has a stable and bounded input/output contract,
produces inspectable evidence, fails closed when evidence is unavailable, and has
a permission posture that the package can support as a public promise.

The accepted Package portfolio is:

| Workflow             | Product role                | Why it belongs                                                                                                                             |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-smoke`         | Child-session diagnostic    | It proves the installed host can create real child sessions with a minimal read-only run.                                                  |
| `llm-smoke`          | Direct-model diagnostic     | It proves `llm()` routing independently from child-session behavior.                                                                       |
| `requirements-grill` | Requirements refinement     | It turns a recurring cross-project intake problem into a bounded structured handoff.                                                       |
| `review`             | Evidence-backed code review | It covers a recurring merge gate with explicit target selection, read-only inspection, structured findings, and a whole-file context pass. |

`review` keeps review and remediation separate. It is an agent pipeline, not an
evidence adapter: the workflow script passes the free-form request and output
templates to full `oracle` child sessions but never reads Git, files, network
resources, or forge APIs itself. The first agent resolves the target and proves
access, two independent agents obtain their own change and whole-context
evidence, and the final agent reopens the target before adjudicating findings.
This design keeps private-forge authentication and repository operations inside
the existing agent/tool environment instead of creating a second
provider-specific integration in the package.

The agents retain their catalog tool surface because evidence acquisition is
their responsibility. `permissionMode: "agent-defined"` records that intent; it
does not enforce read-only behavior. Prompts prohibit repository and remote
mutation, while Pi tool approval remains the real enforcement boundary. The
workflow result contains machine-readable findings and a standalone Markdown
report produced from the literal template supplied to the agents. A later
explicitly authorized process may apply accepted findings.

## Selection boundary

The following shapes are not curated now:

- Generic plan/build/fix orchestration remains project-local because it writes
  code and its acceptance rules depend on repository policy.
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

The Package surface grows from three to four names, but not into a general
automation catalog. This keeps support cost and trusted-code exposure explicit
while making the first reusable merge-gate workflow available by bare name.
