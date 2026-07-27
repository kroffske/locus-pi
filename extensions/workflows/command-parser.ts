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

export function parseRunCommand(text: string): ParsedRunCommand | null {
  const match = /^run\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const scriptRef = match[1] ?? "";
  const rest = (match[2] ?? "").trim();
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
