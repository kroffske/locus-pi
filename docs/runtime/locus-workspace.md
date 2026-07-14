# `.locus/` workspace contract

`.locus/` is the project-local workspace for Locus runtime state and workflow
artifacts. It is not part of the published package surface and must not change
`package.json#pi.extensions`.

## Source truth

- `package.json#pi.extensions` remains the default Pi extension source truth.
- `.locus/runtime/**` stores generated runtime state for the current project.
- `.locus/AGENTS.md` is the local registry for saved `.locus/**` files in this
  checkout. It must list real files, not template-only expectations.
- `.tasks/**`, when present, remains project task truth. `.locus/runtime/artifacts/**` can feed `.tasks/**` only through explicit bridge logic.
- Manual package docs stay under `docs/**`; generated scratch reports belong under `.locus/runtime/reports/**` unless explicitly promoted to release evidence.

## Expected runtime directories

```text
.locus/runtime/artifacts/   # prompt-planning drafts, handoff artifacts, future structured artifacts
.locus/runtime/reports/     # generated scratch reports, inventories, non-package research output
.locus/runtime/runs/        # future agent run envelopes/results/transcripts
.locus/runtime/reviews/     # future review-on-edit or reviewer artifacts
.locus/agents/              # optional project-local agent definitions if this repo adopts the Locus path
```

`/devext doctor` reports whether these directories are present. Reporting directory presence is diagnostic only; it does not prove that beta modules can execute.

## Current saved local files

The current ignored workspace contains local registry, settings, prompts,
roadmap notes, and generated reports:

- `.locus/AGENTS.md`
- `.locus/README.md`
- `.locus/TEST.md`
- `.locus/config.toml`
- `.locus/settings.json`
- `.locus/context/AGENTS.md`
- `.locus/prompts/**`
- `.locus/roadmap.md`
- `.locus/runtime/reports/**`

Template surfaces such as `.locus/goal.md`, `.locus/plan.md`,
`.locus/notes.md`, `.locus/concerns.md`, `.locus/docs/**`,
`.locus/runtime/artifacts/**`, `.locus/runtime/runs/**`,
`.locus/runtime/reviews/**`, and `.locus/agents/**` are not current files in
this checkout unless a later task creates them.

## Git/package policy

- `.gitignore` ignores `.locus/` by default.
- `package.json#files` must not include `.locus`.
- Generated files under `.locus/runtime/**` are local runtime artifacts, not manual docs.
- If a generated report becomes release evidence, move or copy the curated artifact into `docs/evidence.md` or `docs/extension-gallery/` and cite the exact smoke command.
- If `.locus/agents/` becomes canonical, keep `.agents/agents/**` as compatibility fallback until a separate agent-definition decision says otherwise.

## Current integration

- `prompt-planning` writes approved prepared-task artifacts under `.locus/runtime/artifacts/*.json` when manually loaded.
- `devext-doctor` reports `.locus` root, runtime subdirectories, and `.locus/agents` presence.
- No default extension currently writes `.locus/runtime/runs/**` or `.locus/runtime/reviews/**`.

## Verification

Focused coverage:

```bash
bun run vitest run tests/integration/core.test.ts tests/integration/registration.test.ts
```

Full configured gate is still `npm run check` when `npm` is available. In this environment, `npm` may be absent from PATH; `bun run` can execute the same local Vitest/TypeScript scripts if the installed dependency tree is present.
