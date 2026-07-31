/**
 * extensions/workflows/command-parser.ts — `/workflows` argument grammar.
 *
 * Pure text → intent. Each parser returns `null` when the text is not its
 * command at all, and a partial intent carrying an explicit `missing*` flag
 * when the command is recognised but incomplete — the router turns that flag
 * into the operator's retry line, so the wording never lives in the grammar.
 */

export interface ParsedRunCommand {
  scriptRef: string;
  input?: string;
  resumeFromRunId?: string;
  missingResumeId?: boolean;
}

export interface ParsedContinueCommand {
  runId?: string;
  answer?: string;
  missingAnswer?: boolean;
}

/**
 * Encode one workflow target as one command token. Ordinary names and paths
 * stay readable; whitespace, controls, quotes, and backslashes use a JSON
 * string so editor-prefilled commands parse back to the exact same ref.
 */
export function formatWorkflowCommandToken(value: string): string {
  return /^[^\s"\\\u0000-\u001f\u007f-\u009f]+$/u.test(value) ? value : JSON.stringify(value);
}

export function parseRunCommand(text: string): ParsedRunCommand | null {
  const prefix = /^run\s+/u.exec(text);
  if (prefix === null) return null;
  const target = parseWorkflowCommandToken(text.slice(prefix[0].length));
  if (target === undefined || target.value === "") return null;
  const scriptRef = target.value;
  const rest = target.rest.trim();
  if (rest === "") return { scriptRef };
  if (rest === "--resume") return { scriptRef, missingResumeId: true };
  if (rest.startsWith("--resume ")) {
    const after = rest.slice("--resume ".length).trimStart();
    const idMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(after);
    if (idMatch === null) return { scriptRef, missingResumeId: true };
    const resumeFromRunId = idMatch[1] ?? "";
    if (resumeFromRunId === "") return { scriptRef, missingResumeId: true };
    const input = (idMatch[2] ?? "").trim();
    return {
      scriptRef,
      resumeFromRunId,
      ...(input !== "" ? { input } : {}),
    };
  }
  return { scriptRef, input: rest };
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
