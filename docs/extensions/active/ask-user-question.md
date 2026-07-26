# ask-user-question

## Purpose

`ask-user-question` gives the agent a human-in-the-loop primitive: the agent can ask the user one or more OMP-compatible questions through the UI and receive a structured answer. The extension is needed for cases where continuing without a human choice is impossible or unsafe.

## Why it is in the project

The project needs an explicit boundary between autonomous agent work and user decisions. OMP already implements the right contract for such a choice: `questions[]`, `recommended`, `multi`, and an automatic `Other`. The local version uses Pi `ctx.ui.custom` when it is available, to show a bounded checklist/selector with visible `[ ]` / `[x]`, toggle behavior, an explicit `Done selecting`, option navigation, and left/right previous/next navigation between questions. The selector is placed in a typed `SELECT` frame; custom text opens as `[INPUT] Ask custom response` inside the same non-overlay TUI component; the result is separated as `[RESULT] Ask` or `[ERROR] Ask`. Single questions share the same session-generation interaction queue and select/text primitive as actionable workflow handoffs. RPC uses native `select`/`input` requests. If the host does not expose `ctx.ui.custom`, the extension honestly falls back to the built-in `select` / `editor` flow with the same role labels in the titles.

## User Surface

- The agent calls the primary tool `ask` when it needs an answer from the user. The `questions` parameter holds one or more questions with `id`, `question`, `options`, optional `multi`, and optional `recommended`.
- The UI automatically adds `Other (type your own)`, so the caller must not pass that option itself.
- The legacy tool `askUserQuestion` is kept for older callers. It converts the old `question` / `kind` / `options` schema into the new `ask` flow and preserves the redaction behavior for `sensitivity=secret`.
- The extension does not register a slash command: default package surface exposes only the tool/API path, so that the QA command does not clutter the user-facing command list.

## How it works in code

The entrypoint `extensions/ask-user-question/index.ts` registers the TypeBox-backed tool `ask` and the compatibility tool `askUserQuestion`. The handler validates parameters through `_shared/validation.validateParams`, then invokes the OMP-compatible flow.

The primary `ask` uses an OMP-shaped schema: a single question returns `selectedOptions` and optional `customInput`; a multi-question call returns `details.results[]` and an OMP-style text summary of the form `id: value`, `id: [a, b]`, or `id: "custom"`. `recommended` adds the UI suffix ` (Recommended)`, which is then stripped from the result. For `multi=true` the adapter shows a checkbox-style select loop with `[ ]`, `[x]`, `Done selecting`, and `Other (type your own)`. With custom TUI available, `Other` switches to inline text editing without calling `ctx.ui.editor`; the bounded custom surface replaces the editor container (`overlay:false`), stays anchored at the command line, and handles option navigation, toggle behavior, explicit finish, and multi-question previous/next navigation. When custom UI is missing, the legacy select/editor fallback remains in place. After the answer, legacy `askUserQuestion` applies `_shared/redaction.redactForSensitivity`: for `secret` the value is not returned in `details.value`, and the visible answer is redacted. The official Pi dialog contract (`string | undefined`) is normalized in `_shared/operator-input.ts`; the known older object-shaped form is supported only as a compatibility branch. A newer inline prompt taking the single editor slot is normal traffic rather than a defect: the ask tool classifies the typed superseded/stale interaction error and returns `status: "superseded"` with a retryable message, instead of reporting `Ask UI failed`.

The extension writes the developer event `ask:answered` and durable `decision` entry through `_shared/human-control.recordDecision`. With `LOCUS_PI_SESSION_STORE=jsonl` the decision lands in `.locus/runtime/session-state.jsonl`; the Pi custom entry of type `decision` remains a compatibility trail. Escape from a real interactive prompt is recorded as a cancelled decision. `json`, `print`, and an explicit no-UI host return `unavailable` without a false record of a human cancellation.

- Entrypoint: `./extensions/ask-user-question/index.ts`
- Manifest: `extensions/ask-user-question/manifest.json`
- Commands: none
- Tools: `ask`, `askUserQuestion`
- Hooks: none
- Permissions: fs.read=none, fs.write=`.locus/runtime/session-state.jsonl`, subprocess=none, network=none, browser=false, models=false, ui=`select`, `input`, `editor`, `custom`
- State: answers and cancellations are recorded as `decision` session entries; the developer event `ask:answered` remains a lightweight event trail.
- Review: status=reviewed, source=copy-after-audit, reviewedBy=locus-pi, reviewedAt=2026-06-01, risk=medium

## Limitations and risks

Unit smoke covers inline placement, serialized Locus interaction ownership, inline custom text, custom checkbox toggle, explicit `Done selecting`, option navigation, previous/next multi-question navigation, 146/80/48-column rendering, RPC-native single-question dialogs, cancellation decision recording, no-UI behavior, and legacy redaction / durable decision recording. The current bounded custom UI is still a plain-text Pi surface, not the exact OMP renderer. Hosts without `ctx.ui.custom` fall back to the built-in `select` / `editor` path, so parity there is limited by host capability. Pi exposes no global focus lock for unrelated third-party extensions. The broader `_shared/pi-api.ts` dialog-type repair remains deferred.

## Decision

Decision: `compat-wrapper`, active by default. Extension uses OMP-compatible `ask` contract, keeps `askUserQuestion` only as a legacy alias, and exposes a bounded custom UI when Pi supports it.
