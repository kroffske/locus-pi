/**
 * extensions/todo-context/command/command-parser.ts — pure text to intent for the
 * `/todo` grammar: verb/rest splitting, quote-aware tokenization, the
 * `completion-note` argument shape, and the title-casing the append grammar
 * applies to operator text before it becomes stored todo content.
 *
 * No Pi handle, no ExtensionContext, no phase data. Dispatch on the parsed verb
 * stays in `command-router.ts`.
 */

export interface ParsedCompletionNoteInput {
  taskId: string;
  approvalTier: "allow" | "prompt";
  usage?: string;
}

export function splitCommand(input: string): [verb: string, rest: string] {
  const space = input.search(/\s/u);
  return space === -1
    ? [input.toLowerCase(), ""]
    : [input.slice(0, space).toLowerCase(), input.slice(space + 1).trim()];
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < input.length; index++) {
    const ch = input[index]!;
    if (ch === "\\" && index + 1 < input.length) {
      current += input[++index];
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseCompletionNoteInput(rest: string): ParsedCompletionNoteInput {
  const tokens = tokenize(rest);
  if (tokens.length === 0)
    return { taskId: "", approvalTier: "prompt", usage: "Usage: /todo completion-note [--yes] <task-id>" };
  if (tokens[0] === "--yes") {
    if (tokens.length !== 2)
      return { taskId: "", approvalTier: "allow", usage: "Usage: /todo completion-note --yes <task-id>" };
    return { taskId: tokens[1]!, approvalTier: "allow" };
  }
  if (tokens.length !== 1)
    return { taskId: "", approvalTier: "prompt", usage: "Usage: /todo completion-note [--yes] <task-id>" };
  return { taskId: tokens[0]!, approvalTier: "prompt" };
}

export function titleCaseWords(text: string): string {
  return text
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

export function titleCaseSentence(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
}
