# Source audit: ask-user-question

Decision: copy-after-audit. The current extension ports the OMP `ask` tool contract into `locus-pi` and uses Pi custom UI when available; `askUserQuestion` remains a compatibility alias.

OMP source evidence:

- `oh-my-pi:packages/coding-agent/src/tools/ask.ts`
- `oh-my-pi:packages/coding-agent/src/prompts/tools/ask.md`
- `oh-my-pi:packages/coding-agent/test/tools/ask.test.ts`
- `oh-my-pi:docs/tools/ask.md`
- `oh-my-pi:LICENSE`

License/attribution:

- OMP reference is MIT licensed; `oh-my-pi:LICENSE` lists copyright for Mario Zechner and Can Bölük.

Ported contract:

- Primary tool name is `ask`.
- Input shape is `questions[]` with `id`, `question`, `options`, optional `multi`, and optional `recommended`.
- UI automatically adds `Other (type your own)`.
- `multi=true` uses a checkbox-style selector with visible `[ ]` / `[x]` state, toggle behavior, `Done selecting`, and `Other (type your own)`.
- Left/right question navigation is supported in multi-question mode when `ctx.ui.custom` is available.
- Single-question results expose `selectedOptions` and optional `customInput`.
- Multi-question results expose `details.results[]`.
- Cancellation returns an error result locally and records a cancelled Locus `decision` entry.
- Legacy `askUserQuestion` preserves old `sensitivity` / redaction behavior for compatibility.
- Local Locus runtime records answers and cancellations as durable `decision` entries through `_shared/human-control.ts`.
- When `ctx.ui.custom` is unavailable, the extension falls back to `select` / `editor` and loses the bounded checklist/navigation UI.
- When `ctx.ui.custom` is available, the selector uses the shared inline interaction contract (`overlay:false`): Pi replaces the editor container, keeps the question anchored at the command line, restores the editor after completion, and does not cover scrollback.
- Custom selection uses the shared typed `SELECT` frame. Built-in fallback titles carry the same `[SELECT] Ask` role, custom free text uses `[INPUT] Ask custom response`, and final tool rendering uses `[RESULT] Ask` or `[ERROR] Ask`.
- No-UI modes return `unavailable` without recording a cancelled decision, because no human cancellation occurred.

Known gaps:

- The local adapter is a bounded plain-text Pi inline custom UI, not the exact OMP renderer/styling.
- The fallback path is still the older `select` / `editor` surface for hosts without custom UI.
- Decision journaling is Locus-owned runtime behavior, not copied OMP UI code.
- Pi's official `input` / `editor` result is `string | undefined`; `_shared/operator-input.ts` normalizes that plus the known legacy object result. The broader local facade repair is deferred.
