# ast-structural-edit

`ast-structural-edit` — active canonical plugin для OMP-shaped AST workflow. Он нужен, чтобы пользователь и агент видели одну цельную поверхность: `ast_grep` ищет структурные совпадения, `ast_edit` строит preview будущих правок, а `resolve` применяет или отклоняет pending preview.

Важно: `ast_edit` в этой модели не пишет файлы сразу. Это не историческая случайность, а OMP boundary: edit tool показывает proposed rewrite, а запись на диск происходит через `resolve(action: "apply", ...)` после stale-check. Legacy `ast_apply` сохранен только как временный alias для старых callers.

## Зачем нужен

Старые локальные директории `tools-ast-grep`, `tools-ast-edit` и `tools-ast-apply` создавали ощущение трех независимых extensions. Новый plugin фиксирует правильный product boundary: это один AST Structural Edit plugin с тремя фазами search -> preview -> resolve.

## Как работает

Entrypoint `extensions/ast-structural-edit/index.ts` регистрирует три локальных OMP-compatible implementation modules, которыми владеет этот active extension:

- `ast_grep` из `extensions/ast-structural-edit/ast-grep.ts`;
- `ast_edit` из `extensions/ast-structural-edit/ast-edit.ts`;
- `resolve` и legacy `ast_apply` из `extensions/ast-structural-edit/resolve.ts`.

Старые `tools-ast-grep`, `tools-ast-edit` и `tools-ast-apply` больше не являются
отдельными beta extensions: их duplicate manifests и manuals удалены после
переноса implementation в canonical active owner.

Сам plugin входит в `package.json#pi.extensions` как bounded compatibility wrapper. Он уже предоставляет OMP-shaped lifecycle search -> preview -> resolve, объявляет Pi approval metadata для apply-write и проверяет stale файлы перед записью. Локального Locus `ctx.ui.confirm` слоя больше нет: prompt/deny/allow решения выполняет Pi native approval wrapper до входа в tool handler. Полная OMP forced hidden tool-choice queue еще не портирована, поэтому local `resolve` остается explicit tool и берет последний pending AST preview внутри текущего project root.

Safe apply protocol:

1. `ast_grep` reads project files and reports structural matches.
2. `ast_edit` creates an in-memory preview with file hashes and does not write files.
3. `resolve(action: "apply", reason, extra.previewId?)` is declared as a Pi `write` approval tier before any write.
4. After Pi lets the call reach the handler, `resolve` compares live file hashes against preview hashes.
5. If any file changed, `resolve` returns an error with `details.stale[]` and leaves live files unchanged.
6. If hashes still match, `resolve` writes the preview and removes it from the pending registry.

## User Surface

- Tools: `ast_grep`, `ast_edit`, `resolve`, `ast_apply`.
- Commands: none.
- Hooks: none.
- Default enabled: yes.
- Permissions: fs.read=`.`, fs.write=`.`, ui=none; Pi tool approval metadata marks apply as `write`.
- Ownership: `compat-wrapper`, moving toward `OMP-owned-to-import`.

## OMP Source Evidence

- `/tmp/oh-my-pi-review/packages/coding-agent/src/tools/ast-grep.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/src/tools/ast-edit.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/src/tools/resolve.ts`
- `/tmp/oh-my-pi-review/docs/tools/ast-grep.md`
- `/tmp/oh-my-pi-review/docs/tools/ast-edit.md`
- `/tmp/oh-my-pi-review/docs/tools/resolve.md`

## Current Gaps

`locus-pi` еще не умеет OMP forced hidden tool-choice queue для `resolve`, поэтому `resolve` берет последний pending AST preview из локального in-memory registry. Apply-write больше не enforced через Locus-owned `approval-policy`; Pi native approval settings decide whether the `write` tier call is allowed, prompted, or denied before the handler runs.
