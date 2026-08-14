# ast-structural-edit

## Purpose

This default extension provides one structural-edit lifecycle: `ast_grep` searches, `ast_edit` creates a preview, and `resolve` either applies or discards it.

## Executive summary of preview resolution

`ast_edit` never changes a source file. It stores proposed replacements and the hash of every source file it read. `resolve(action: "discard")` deletes that pending proposal and leaves the project untouched. `resolve(action: "apply")` first rereads every affected file and compares its current hash with the saved hash. If any file changed after the preview was created, the whole apply is refused before the first write. If every hash still matches, the prepared contents are written and the preview is removed.

This protects against applying an edit to code that changed while the preview was awaiting approval. It is not a transaction with rollback: once the preflight hash check succeeds, writes happen file by file, so an operating-system failure during a multi-file write can still leave a partial result.

## Implementation boundary

The parser and structural matcher come from the local npm dependencies `@ast-grep/napi` and `@ast-grep/lang-python`. Locus owns the TypeBox tool schemas, project-root confinement, preview registry, stale-file check, and Pi approval metadata. No external service or network call is involved.

## Surface

- Tools: `ast_grep`, `ast_edit`, `resolve`
- Commands and hooks: none
- State: in-memory pending previews
- Permissions: project file read; project file write only for `resolve(action: "apply")` after Pi write approval

The former `ast_apply` alias was removed. `resolve` is the only preview finalizer.
