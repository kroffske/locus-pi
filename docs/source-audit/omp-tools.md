# Source audit: omp-tools

Decision: copy-after-audit, active compatibility wrapper. Selected OMP-style tools are being ported into local `locus-pi` plugin/API surfaces. AST now has a canonical active `ast-structural-edit` plugin that registers `ast_grep`, `ast_edit`, `resolve`, and legacy `ast_apply` together. `resolve` is the primary preview finalizer, defaults to the latest pending AST preview in the current project root, and keeps `ast_apply` only as a compatibility alias.

OMP source evidence:
- `/tmp/oh-my-pi-review/packages/coding-agent/src/tools/ast-grep.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/src/tools/ast-edit.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/src/tools/resolve.ts`
- `/tmp/oh-my-pi-review/docs/tools/ast-grep.md`
- `/tmp/oh-my-pi-review/docs/tools/ast-edit.md`
- `/tmp/oh-my-pi-review/docs/tools/resolve.md`
- `/tmp/oh-my-pi-review/LICENSE`

License note: OMP checkout is MIT-licensed. Local AST behavior ports selected OMP-compatible contracts and records exact source evidence here; remaining OMP runtime behavior must keep this attribution trail updated.

Active wrapper contract:
- `ast_grep` is the read-only structural search surface.
- `ast_edit` creates a preview and never writes files directly.
- `resolve` applies or discards the pending preview. Apply is declared as a Pi `write` approval tier and then performs stale-file checks before writes.
- `ast_apply` remains a legacy alias for old callers.

Local implementation owner:
- `extensions/ast-structural-edit/ast-grep.ts`
- `extensions/ast-structural-edit/ast-edit.ts`
- `extensions/ast-structural-edit/resolve.ts`
- `extensions/ast-structural-edit/index.ts`

Known gap:
- Full OMP parity is not claimed. OMP owns forced hidden `resolve` tool-choice queue behavior; local `locus-pi` uses explicit `resolve` and latest pending preview lookup.
- Full OMP approval UI parity is not claimed. Local Locus approval enforcement was removed; Pi native approval settings own prompt/deny behavior.

Local evidence owner: source files, manifests, tests, E2E visual report, and task artifacts under `T-101-ast-structural-edit`.
