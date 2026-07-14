# Extension docs

Эта директория содержит manual extension documentation. Структура основана на
runtime status, а не на удобстве implementation layout.

## Read order

1. Проверь `package.json#pi.extensions` как default-load list.
2. Читай [active/](active/) для default extensions.
3. Beta, fixture и future-design docs остаются repository-only и не входят в
   npm v1 package.
4. Используй [../extension-index.md](../extension-index.md) и
   [../extension-ownership-matrix.md](../extension-ownership-matrix.md) как
   status ledger.

## Current buckets

- `active/` описывает default-loaded extensions. Канонический roster и счёт —
  в [../README.md](../README.md#source-truth) (см. строку `Registered extensions`),
  backed by `package.json#pi.extensions`.
- Repository-only `beta/` and future-design material do not ship in the npm v1
  tarball and do not represent default registration.

Не заменяй эти manual pages generated gallery prose. Generated gallery output
лежит в `docs/extension-gallery/`; границу runtime-scratch reports см. в
[../runtime/locus-workspace.md](../runtime/locus-workspace.md).
