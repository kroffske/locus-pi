/**
 * extensions/plan/command-parser.ts — pure text -> intent for this extension's
 * command grammars: the leading verb every command splits on, the /goal budget
 * argument, the /goal continue free-form body, and the `--task` prefix /goal-ai
 * accepts. No Pi handle, no disk access.
 */

export function splitFirstWord(input: string): [string, string] {
  const trimmed = input.trim();
  if (!trimmed) return ["", ""];
  const match = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed);
  if (!match) return ["", ""];
  return [match[1]!.toLowerCase(), match[2]!.trim()];
}

export function parseBudget(input: string): { valid: boolean; value: string } {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === "off") return { valid: true, value: "off" };
  if (!/^[1-9][0-9]*$/u.test(trimmed)) return { valid: false, value: "" };
  return { valid: true, value: trimmed };
}

export function parseContinuationInput(raw: string): { summary?: string; nextStep?: string; remainingRisks: string[] } {
  const trimmed = raw.trim();
  if (trimmed === "") return { remainingRisks: [] };
  const parts = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = parts[0];
  const nextStep = parts[1];
  const remainingRisks = parts.slice(2);
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(nextStep === undefined ? {} : { nextStep }),
    remainingRisks,
  };
}

export function parsePromptCommandInput(text: string): {
  target: { type: "project" } | { type: "task"; taskId: string };
  prompt: string;
} {
  const trimmed = text.trim();
  const taskEquals = /^--task=([^\s]+)\s*([\s\S]*)$/u.exec(trimmed);
  if (taskEquals !== null) return { target: { type: "task", taskId: taskEquals[1]! }, prompt: taskEquals[2]!.trim() };

  const taskSeparated = /^--task\s+([^\s]+)\s*([\s\S]*)$/u.exec(trimmed);
  if (taskSeparated !== null)
    return { target: { type: "task", taskId: taskSeparated[1]! }, prompt: taskSeparated[2]!.trim() };

  return { target: { type: "project" }, prompt: trimmed };
}
