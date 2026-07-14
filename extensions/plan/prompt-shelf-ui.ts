import type { OperatorBlock } from "../_shared/operator-ui.js";
import type { PromptCommandTargetSelector } from "../_shared/prompt-command-store.js";

export type PromptShelfKind = "goal" | "review" | "todos";

export interface PromptShelfTarget {
  kind: PromptShelfKind;
  target: "project-local" | `task:${string}`;
  path: string;
  displayPath: string;
}

export type PromptShelfAction =
  | { kind: "summary" }
  | { kind: "show" }
  | { kind: "write"; prompt: string }
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
 * value retains the old free-form write contract.
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
      action: prompt === ""
        ? { kind: "invalid", message: "set requires a non-empty prompt" }
        : { kind: "write", prompt },
    };
  }
  return {
    target: selected.target,
    targetLabel: selected.targetLabel,
    action: { kind: "write", prompt: remaining },
  };
}

export function promptShelfSummaryBlock(
  kind: PromptShelfKind,
  target: PromptShelfTarget,
  saved: string | undefined,
): OperatorBlock {
  const label = promptShelfLabel(kind);
  const command = promptShelfScopedCommand(kind, target.target);
  if (saved === undefined) {
    return {
      type: "WARN",
      subject: label,
      primary: `No saved ${promptShelfNoun(kind).toLowerCase()} prompt. This target is empty.`,
      badges: [{ text: "EMPTY", tone: "muted" }],
      metadata: promptShelfMetadata(target),
      controls: [`Save: ${command} set <prompt>`],
    };
  }
  const stats = promptStats(saved);
  return {
    type: "VIEW",
    subject: label,
    primary: `Saved ${promptShelfNoun(kind).toLowerCase()} prompt. The body is hidden from this summary.`,
    badges: [{ text: "SAVED", tone: "success" }],
    metadata: [...promptShelfMetadata(target), `lines: ${stats.lines}`, `characters: ${stats.characters}`],
    controls: [`Open body: ${command} show`, `Replace: ${command} set <prompt>`],
  };
}

export function promptShelfBodyBlock(
  kind: PromptShelfKind,
  target: PromptShelfTarget,
  saved: string | undefined,
  options: { compact?: boolean } = {},
): OperatorBlock {
  const label = promptShelfLabel(kind);
  const command = promptShelfScopedCommand(kind, target.target);
  if (saved === undefined) {
    return {
      type: "WARN",
      subject: label,
      primary: "No saved prompt body exists for this target.",
      metadata: promptShelfMetadata(target),
      controls: [`Save: ${command} set <prompt>`],
    };
  }
  const fullBody = saved.trimEnd().split(/\r?\n/u);
  const visibleBody = options.compact === true ? fullBody.slice(0, 3) : fullBody;
  const hidden = fullBody.length - visibleBody.length;
  return {
    type: "VIEW",
    subject: `${label} body`,
    primary: `Explicit body view: ${fullBody.length} line(s).`,
    body: [...visibleBody, ...(hidden > 0 ? [`(+${hidden} hidden; full body: ${compactPromptShelfPath(target)})`] : [])],
    metadata: options.compact === true
      ? [`target: ${target.target}`, `path: ${compactPromptShelfPath(target)}`]
      : promptShelfMetadata(target),
    controls: options.compact === true
      ? [`Return to summary: ${command}`]
      : [`Return to summary: ${command}`, `Replace: ${command} set <prompt>`],
  };
}

export function promptShelfChangeBlock(kind: PromptShelfKind, target: PromptShelfTarget): OperatorBlock {
  const command = promptShelfScopedCommand(kind, target.target);
  return {
    type: "CHANGE",
    subject: promptShelfLabel(kind),
    primary: `${promptShelfNoun(kind)} prompt saved.`,
    badges: [{ text: "ARTIFACT", tone: "success" }],
    metadata: promptShelfMetadata(target),
    controls: [`Inspect: ${command}`, `Open body: ${command} show`],
  };
}

export function promptShelfWarningBlock(
  kind: PromptShelfKind,
  primary: string,
  targetLabel: string,
  details: readonly string[] = [],
): OperatorBlock {
  const command = promptShelfScopedCommand(kind, targetLabel);
  return {
    type: "WARN",
    subject: promptShelfLabel(kind),
    primary,
    body: [...details],
    metadata: [`target: ${targetLabel}`, `kind: ${kind}`],
    controls: [`Summary: ${command}`, `Write literal verbs: ${command} set <prompt>`],
  };
}

export function promptShelfErrorBlock(kind: PromptShelfKind, error: unknown, targetLabel: string): OperatorBlock {
  const message = error instanceof Error ? error.message : String(error);
  const command = promptShelfScopedCommand(kind, targetLabel);
  return {
    type: "ERROR",
    subject: promptShelfLabel(kind),
    primary: "Prompt shelf operation failed; no successful write is claimed.",
    body: [`error: ${message}`],
    metadata: [`target: ${targetLabel}`, `kind: ${kind}`],
    controls: [`Summary: ${command}`],
  };
}

export function promptShelfLabel(kind: PromptShelfKind): string {
  if (kind === "goal") return "Goal prompt shelf";
  if (kind === "review") return "Review prompt shelf";
  return "Todos prompt shelf";
}

function promptShelfNoun(kind: PromptShelfKind): string {
  if (kind === "goal") return "Goal";
  if (kind === "review") return "Review";
  return "Todos";
}

function promptShelfCommand(kind: PromptShelfKind): string {
  return kind === "goal" ? "/goal prompt" : `/${kind}`;
}

function promptShelfScopedCommand(
  kind: PromptShelfKind,
  target: PromptShelfTarget["target"] | string,
): string {
  const command = promptShelfCommand(kind);
  if (!target.startsWith("task:")) return command;
  const taskId = target.slice("task:".length);
  return taskId === "" || taskId === "(missing)" ? `${command} --task <task-id>` : `${command} --task ${taskId}`;
}

function promptShelfMetadata(target: PromptShelfTarget): string[] {
  return [`target: ${target.target}`, `kind: ${target.kind}`, `path: ${compactPromptShelfPath(target)}`];
}

function compactPromptShelfPath(target: PromptShelfTarget): string {
  if (!target.target.startsWith("task:")) return target.displayPath;
  const artifactPath = /\/artifacts\/[^/]+$/u.exec(target.displayPath)?.[0];
  if (artifactPath === undefined) return target.displayPath;
  return `.tasks/${target.target.slice("task:".length)}${artifactPath}`;
}

function promptStats(prompt: string): { lines: number; characters: number } {
  const normalized = prompt.trimEnd();
  return {
    lines: normalized === "" ? 0 : normalized.split(/\r?\n/u).length,
    characters: normalized.length,
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
