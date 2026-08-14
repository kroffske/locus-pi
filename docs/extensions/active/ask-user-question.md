# ask-user-question

## Purpose

`ask-user-question` gives the model one human-decision tool: `ask`.

## Public contract

`ask` accepts either of two shapes:

- `{ questions: [...] }` for one or more OMP-compatible option questions;
- `{ question, kind, ... }` for one rich `select`, `multi-select`, `text`, or `editor` question with optional sensitivity and reason metadata.

Option questions support recommended answers, multiple selection, custom input, navigation, and per-question `timeoutMs`. Text/editor host dialogs reject `timeoutMs` explicitly because Pi does not provide cancellable timing for those native dialogs. Secret answers are redacted from the visible result and durable decision entry.

The removed `askUserQuestion` name was only a second public registration. Its useful rich schema and redaction behavior now live under `ask`, so no capability was lost.

## Code map

- Entrypoint: `extensions/ask-user-question/index.ts`
- Schema and dispatch: `extensions/ask-user-question/ask-tool.ts`
- Option flow: `extensions/ask-user-question/question-runner.ts`
- Rich single-question flow: `extensions/ask-user-question/legacy-ask.ts`
- Tools: `ask`
- Commands and hooks: none
- State: durable `decision` session entries
