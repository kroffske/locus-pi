# Extension docs

This directory holds the manual extension documentation. The structure follows
runtime status, not the convenience of the implementation layout.

## Read order

1. Check `package.json#pi.extensions` as the default-load list.
2. Read [active/](active/) for the default extensions.
3. Beta, fixture and future-design docs stay repository-only and are not part of
   the npm v1 package.
4. Use [../extension-index.md](../extension-index.md) and
   [../extension-ownership-matrix.md](../extension-ownership-matrix.md) as the
   status ledger.

## Current buckets

- `active/` describes the default-loaded extensions. The canonical roster and
  count live in [../README.md](../README.md#source-truth) (see the
  `Registered extensions` line), backed by `package.json#pi.extensions`.
- Repository-only `beta/` and future-design material do not ship in the npm v1
  tarball and do not represent default registration.

Do not replace these manual pages with generated gallery prose. Generated
gallery output lives in `docs/extension-gallery/`; for the runtime-scratch
report boundary see [../runtime/locus-workspace.md](../runtime/locus-workspace.md).
