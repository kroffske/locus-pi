/**
 * extensions/plan/prompt-shelf/prompt-shelf-ui.ts — pure OperatorBlock builders for the
 * prompt shelf `/review`, `/todos` and `/goal prompt` share: the summary, the
 * explicit body view, the saved receipt, and the warning/error blocks, plus the
 * label and path vocabulary they render. No Pi handle, no artifact access; the
 * grammar these blocks answer to is parsed in `command-parser.ts` and the
 * ctx-bound writes happen in `operator-surface.ts`.
 */

import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import type { PromptShelfKind, PromptShelfTarget, PromptShelfWriteSource } from "../command/command-parser.js";

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
    body: [
      ...visibleBody,
      ...(hidden > 0 ? [`(+${hidden} hidden; full body: ${compactPromptShelfPath(target)})`] : []),
    ],
    metadata:
      options.compact === true
        ? [`target: ${target.target}`, `path: ${compactPromptShelfPath(target)}`]
        : promptShelfMetadata(target),
    controls:
      options.compact === true
        ? [`Return to summary: ${command}`]
        : [`Return to summary: ${command}`, `Replace: ${command} set <prompt>`],
  };
}

export function promptShelfChangeBlock(
  kind: PromptShelfKind,
  target: PromptShelfTarget,
  source: PromptShelfWriteSource = "explicit",
): OperatorBlock {
  const command = promptShelfScopedCommand(kind, target.target);
  const primary =
    source === "legacy"
      ? `${promptShelfNoun(kind)} prompt saved. Deprecated: ${command} set <prompt>.`
      : `${promptShelfNoun(kind)} prompt saved.`;
  return {
    type: "CHANGE",
    subject: promptShelfLabel(kind),
    primary,
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
  const message = errorMessage(error);
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

function promptShelfScopedCommand(kind: PromptShelfKind, target: PromptShelfTarget["target"] | string): string {
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
