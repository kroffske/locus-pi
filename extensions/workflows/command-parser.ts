/**
 * extensions/workflows/command-parser.ts — `/workflows` argument grammar.
 *
 * Pure text → intent. Each parser returns `null` when the text is not its
 * command at all, and a partial intent carrying an explicit `missing*` flag
 * when the command is recognised but incomplete. This module also owns the
 * shared run-grammar and value-preserving recovery presentation used by command
 * surfaces, so parsing and operator syntax cannot drift apart.
 */

import { isPostCodeReviewTargetIdentity, type WorkflowTargetIdentity } from "./runtime/workflow-saved-name.js";

export interface ParsedRunCommand {
  scriptRef: string;
  input?: string;
  outputDir?: string;
  resumeFromRunId?: string;
  missingOutputDir?: boolean;
  missingResumeId?: boolean;
}

export interface ParsedContinueCommand {
  runId?: string;
  answer?: string;
  missingAnswer?: boolean;
}

const WORKFLOW_RUN_OPTION_USAGE = "[--output-dir <path>] [--resume <runId>] [--] [input]";

export const WORKFLOW_RUN_OPTION_DESCRIPTORS = [
  { name: "--output-dir", field: "outputDir" },
  { name: "--resume", field: "resumeFromRunId" },
] as const;
export type WorkflowRunOptionDescriptor = (typeof WORKFLOW_RUN_OPTION_DESCRIPTORS)[number];

export function workflowRunOptionDescriptor(value: string): WorkflowRunOptionDescriptor | undefined {
  return WORKFLOW_RUN_OPTION_DESCRIPTORS.find((descriptor) => value === descriptor.name);
}

export function workflowRunOptionAtStart(
  value: string,
): { descriptor: WorkflowRunOptionDescriptor; after: string } | undefined {
  for (const descriptor of WORKFLOW_RUN_OPTION_DESCRIPTORS) {
    if (value === descriptor.name) return { descriptor, after: "" };
    const suffix = value.slice(descriptor.name.length);
    if (value.startsWith(descriptor.name) && /^\s/u.test(suffix)) {
      return { descriptor, after: suffix.trimStart() };
    }
  }
  return undefined;
}

export function scanWorkflowRunOptionTokens(rawTail: string): { tokens: string[]; endsWithSpace: boolean } | undefined {
  const tail = rawTail.trim();
  const tokens: string[] = [];
  let remaining = tail;
  while (remaining !== "") {
    const parsed = parseWorkflowCommandToken(remaining);
    if (parsed === undefined) return undefined;
    tokens.push(parsed.value);
    remaining = parsed.rest;
  }
  return { tokens, endsWithSpace: /\s$/u.test(rawTail) };
}

/** Canonical presentation of the run grammar for command, help, and recovery surfaces. */
export function workflowRunUsage(target = "<name|path>", command = "/workflows run"): string {
  return `${command} ${target} ${WORKFLOW_RUN_OPTION_USAGE}`;
}

/** Preserve accepted run options while showing the one missing value. */
export function workflowRunRecoveryUsage(parsed: ParsedRunCommand): string {
  const parts = ["/workflows run", formatWorkflowCommandToken(parsed.scriptRef)];
  if (parsed.missingOutputDir === true) {
    if (parsed.outputDir !== undefined) parts.push("--output-dir", formatWorkflowCommandToken(parsed.outputDir));
    parts.push("--output-dir", "<path>");
    if (parsed.resumeFromRunId === undefined) parts.push("[--resume <runId>]");
    else parts.push("--resume", formatWorkflowCommandToken(parsed.resumeFromRunId));
  } else {
    if (parsed.outputDir === undefined) parts.push("[--output-dir <path>]");
    else parts.push("--output-dir", formatWorkflowCommandToken(parsed.outputDir));
    if (parsed.resumeFromRunId !== undefined)
      parts.push("--resume", formatWorkflowCommandToken(parsed.resumeFromRunId));
    parts.push("--resume", "<runId>");
  }
  parts.push("[--]", "[input]");
  return parts.join(" ");
}

/**
 * Encode one workflow target as one command token. Ordinary names and paths
 * stay readable; whitespace, controls, quotes, and backslashes use a JSON
 * string so editor-prefilled commands parse back to the exact same ref.
 */
export function formatWorkflowCommandToken(value: string): string {
  return /^[^\s"\\\u0000-\u001f\u007f-\u009f]+$/u.test(value) ? value : JSON.stringify(value);
}

/** Build the canonical editable run command for a resolved workflow target. */
export function buildWorkflowRunCommand(target: WorkflowTargetIdentity, projectRoot?: string): string {
  const outputNamespace = isPostCodeReviewTargetIdentity(target, projectRoot)
    ? " --output-dir tmp/post-code-review/<review-id>"
    : "";
  return `/workflows run ${formatWorkflowCommandToken(target.ref)}${outputNamespace}`;
}

export function parseRunCommand(text: string): ParsedRunCommand | null {
  const prefix = /^run\s+/u.exec(text);
  if (prefix === null) return null;
  const target = parseWorkflowCommandToken(text.slice(prefix[0].length));
  if (target === undefined || target.value === "") return null;
  const scriptRef = target.value;
  // Keep one leading separator out of the first token, but retain the raw tail
  // until we know whether `--` switches the rest into semantic-input mode.
  let rest = target.rest.trimStart();
  let outputDir: string | undefined;
  let resumeFromRunId: string | undefined;
  const missing = (option: WorkflowRunOptionDescriptor): ParsedRunCommand => ({
    scriptRef,
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    ...(option.field === "outputDir" ? { missingOutputDir: true } : { missingResumeId: true }),
  });
  // Match the existing command-option convention: when an option is repeated
  // before semantic input, its last supplied value wins.
  while (true) {
    const matched = workflowRunOptionAtStart(rest);
    if (matched === undefined) break;
    const option = matched.descriptor;
    const after = matched.after;
    if (after === "") {
      return missing(option);
    }
    const value = parseWorkflowCommandToken(after);
    if (
      value === undefined ||
      value.value === "" ||
      value.value === "--" ||
      value.value === "--output-dir" ||
      value.value === "--resume"
    ) {
      return missing(option);
    }
    if (option.field === "outputDir") outputDir = value.value;
    else resumeFromRunId = value.value;
    rest = value.rest.trimStart();
  }
  if (rest === "--") {
    return {
      scriptRef,
      ...(outputDir === undefined ? {} : { outputDir }),
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    };
  }
  if (/^--\s/u.test(rest)) {
    const input = rest.slice(3);
    return {
      scriptRef,
      ...(outputDir === undefined ? {} : { outputDir }),
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
      ...(input === "" ? {} : { input }),
    };
  }
  const input = rest.trim();
  return {
    scriptRef,
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    ...(input === "" ? {} : { input }),
  };
}

export function parseWorkflowCommandToken(text: string): { value: string; rest: string } | undefined {
  if (text.startsWith('"')) {
    const match = /^"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"/u.exec(text);
    if (match === null) return undefined;
    const token = match[0];
    const rest = text.slice(token.length);
    if (rest !== "" && !/^\s/u.test(rest)) return undefined;
    try {
      const value: unknown = JSON.parse(token);
      return typeof value === "string" ? { value, rest: rest.trimStart() } : undefined;
    } catch {
      return undefined;
    }
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text);
  return match === null ? undefined : { value: match[1] ?? "", rest: match[2] ?? "" };
}

export function parseContinueCommand(text: string): ParsedContinueCommand | null {
  if (text === "continue") return {};
  const match = /^continue\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const runId = match[1];
  const tail = (match[2] ?? "").trim();
  if (runId === undefined || runId === "") return {};
  if (tail === "") return { runId };
  if (tail === "--answer") return { runId, missingAnswer: true };
  if (!tail.startsWith("--answer ")) return { runId, missingAnswer: true };
  const answer = tail.slice("--answer ".length).trim();
  return answer === "" ? { runId, missingAnswer: true } : { runId, answer };
}
