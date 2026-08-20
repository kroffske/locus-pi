/**
 * extensions/plan/command-parser.ts — pure text -> intent for this extension's
 * command grammars: the leading verb every command splits on, the /goal budget
 * argument, the /goal continue free-form body, the `--task` prefix /goal-ai
 * accepts, and the whole prompt-shelf grammar `/review`, `/todos` and
 * `/goal prompt` share. No Pi handle, no disk access; the blocks these intents
 * render live in `prompt-shelf-ui.ts` and `operator-ui.ts`.
 */

import type { PromptCommandTargetSelector } from "../_shared/project/prompt-command-store.js";

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

export type PromptShelfKind = "goal" | "review" | "todos";

export interface PromptShelfTarget {
  kind: PromptShelfKind;
  target: "project-local" | `task:${string}`;
  path: string;
  displayPath: string;
}

export type PromptShelfWriteSource = "explicit" | "legacy";

export type PromptShelfAction =
  | { kind: "summary" }
  | { kind: "show" }
  | { kind: "write"; prompt: string; source: PromptShelfWriteSource }
  | { kind: "invalid"; message: string };

export interface ParsedPromptShelfCommand {
  target: PromptCommandTargetSelector;
  targetLabel: string;
  action: PromptShelfAction;
}

/**
 * Parse one prompt-shelf command without reading or writing artifacts.
 *
 * `show` and `read` are exact body-view verbs. `set <prompt>` is the escape
 * that keeps those words storable as literal prompts. Every other non-empty
 * value retains the old free-form write contract and is marked as legacy so
 * the result can guide callers to the canonical spelling.
 */
export function parsePromptShelfCommand(text: string): ParsedPromptShelfCommand {
  const selected = parseTargetPrefix(text.trim());
  if (selected.error !== undefined) {
    return {
      target: selected.target,
      targetLabel: selected.targetLabel,
      action: { kind: "invalid", message: selected.error },
    };
  }

  const remaining = selected.remaining.trim();
  if (remaining === "") {
    return { target: selected.target, targetLabel: selected.targetLabel, action: { kind: "summary" } };
  }
  if (remaining === "show" || remaining === "read") {
    return { target: selected.target, targetLabel: selected.targetLabel, action: { kind: "show" } };
  }
  if (remaining === "set") {
    return {
      target: selected.target,
      targetLabel: selected.targetLabel,
      action: { kind: "invalid", message: "set requires a non-empty prompt" },
    };
  }
  if (remaining.startsWith("set ")) {
    const prompt = remaining.slice(4).trim();
    return {
      target: selected.target,
      targetLabel: selected.targetLabel,
      action:
        prompt === ""
          ? { kind: "invalid", message: "set requires a non-empty prompt" }
          : { kind: "write", prompt, source: "explicit" },
    };
  }
  return {
    target: selected.target,
    targetLabel: selected.targetLabel,
    action: { kind: "write", prompt: remaining, source: "legacy" },
  };
}

function parseTargetPrefix(text: string): {
  target: PromptCommandTargetSelector;
  targetLabel: string;
  remaining: string;
  error?: string;
} {
  if (text.startsWith("--task=")) {
    const [token = "", ...rest] = text.split(/\s+/u);
    const taskId = token.slice("--task=".length).trim();
    return taskId === ""
      ? {
          target: { type: "task", taskId: "" },
          targetLabel: "task:(missing)",
          remaining: rest.join(" "),
          error: "--task requires a non-empty task id",
        }
      : {
          target: { type: "task", taskId },
          targetLabel: `task:${taskId}`,
          remaining: rest.join(" "),
        };
  }

  if (text === "--task" || text.startsWith("--task ")) {
    const parts = text.split(/\s+/u);
    const taskId = parts[1]?.trim() ?? "";
    return taskId === ""
      ? {
          target: { type: "task", taskId: "" },
          targetLabel: "task:(missing)",
          remaining: parts.slice(2).join(" "),
          error: "--task requires a non-empty task id",
        }
      : {
          target: { type: "task", taskId },
          targetLabel: `task:${taskId}`,
          remaining: parts.slice(2).join(" "),
        };
  }

  return { target: { type: "project" }, targetLabel: "project-local", remaining: text };
}
