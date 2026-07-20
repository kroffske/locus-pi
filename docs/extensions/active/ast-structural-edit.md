# ast-structural-edit

`ast-structural-edit` is the active canonical plugin for the OMP-shaped AST workflow. It exists so that the user and the agent see one coherent surface: `ast_grep` searches for structural matches, `ast_edit` builds a preview of the upcoming edits, and `resolve` applies or rejects a pending preview.

Important: in this model `ast_edit` does not write files immediately. This is not a historical accident but an OMP boundary: the edit tool shows the proposed rewrite, and the write to disk happens through `resolve(action: "apply", ...)` after a stale check. Legacy `ast_apply` is kept only as a temporary alias for older callers.

## Why it is needed

The old local directories `tools-ast-grep`, `tools-ast-edit`, and `tools-ast-apply` gave the impression of three independent extensions. The new plugin fixes the correct product boundary: this is one AST Structural Edit plugin with three phases, search -> preview -> resolve.

## How it works

The entrypoint `extensions/ast-structural-edit/index.ts` registers three local OMP-compatible implementation modules owned by this active extension:

- `ast_grep` from `extensions/ast-structural-edit/ast-grep.ts`;
- `ast_edit` from `extensions/ast-structural-edit/ast-edit.ts`;
- `resolve` and legacy `ast_apply` from `extensions/ast-structural-edit/resolve.ts`.

The old `tools-ast-grep`, `tools-ast-edit`, and `tools-ast-apply` are no longer
separate beta extensions: their duplicate manifests and manuals were removed after
the implementation moved into the canonical active owner.

The plugin itself is listed in `package.json#pi.extensions` as a bounded compatibility wrapper. It already provides the OMP-shaped lifecycle search -> preview -> resolve, declares Pi approval metadata for the apply-write, and checks for stale files before writing. There is no local Locus `ctx.ui.confirm` layer any more: prompt/deny/allow decisions are made by the Pi native approval wrapper before the tool handler is entered. The full OMP forced hidden tool-choice queue has not been ported yet, so the local `resolve` remains an explicit tool and takes the most recent pending AST preview within the current project root.

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

- `oh-my-pi:packages/coding-agent/src/tools/ast-grep.ts`
- `oh-my-pi:packages/coding-agent/src/tools/ast-edit.ts`
- `oh-my-pi:packages/coding-agent/src/tools/resolve.ts`
- `oh-my-pi:docs/tools/ast-grep.md`
- `oh-my-pi:docs/tools/ast-edit.md`
- `oh-my-pi:docs/tools/resolve.md`

## Current Gaps

`locus-pi` does not yet support the OMP forced hidden tool-choice queue for `resolve`, so `resolve` takes the most recent pending AST preview from the local in-memory registry. The apply-write is no longer enforced through a Locus-owned `approval-policy`; Pi native approval settings decide whether the `write` tier call is allowed, prompted, or denied before the handler runs.
