import { readFileSync } from "node:fs";
import type { AgentParentContext, AgentRunRequest } from "./agent-runner.js";
import type { ModelRoleResolutionRecord } from "../model/model-settings.js";
import { modelRoleResolutionRecord } from "../model/model-settings.js";
import { buildAgentSystemPrompt } from "./agent-system-prompt.js";
import { OUTPUT_DEFAULTS } from "../host/safe-output.js";

/**
 * The prompt capsule and text-result layer every live agent execution goes through.
 *
 * WHY THIS FILE IS SEPARATE FROM agent-executor-host.ts
 *
 * These two concerns used to share one 584-line module, and the mix hid which half the
 * product actually runs. `agent-sdk-host.ts` — the only production importer — takes exactly
 * three symbols from that module (`createAgentExecutionPromptCapsule`,
 * `formatAgentKickoffPrompt`, `parseAgentText`), and they are all here. Everything left in
 * `agent-executor-host.ts` is the superseded replacement-session path that
 * `docs/source-audit/agents.md` records as retained provenance: no registered entrypoint
 * reaches it.
 *
 * Keeping them in one file meant a reader could not tell the live capsule builder from dead
 * provenance without tracing imports, and any edit to the live path sat next to code nobody
 * runs. The split makes the production surface the whole content of one file, so the boundary
 * is visible instead of inferred — and it makes the dependency direction explicit: the
 * historical module imports this one, never the reverse.
 */
export interface AgentExecutionPromptCapsule {
  version: "locus.agent.prompt.v1";
  agentName: string;
  capabilityMode?: "tool-free" | "agent";
  agentDefinitionPath?: string;
  task: string;
  projectRoot: string;
  workingDirectory: string;
  allowedTools: string[];
  maxTurns: number;
  depth: number;
  maxDepth: number;
  modelRole?: ModelRoleResolutionRecord;
  agentSystemPrompt?: string;
  contextDiagnostics?: string[];
  parentContext?: string;
}

export function createAgentExecutionPromptCapsule(
  request: AgentRunRequest,
  diagnostics: string[] = [],
  promptEnv: NodeJS.ProcessEnv | undefined = process.env,
): AgentExecutionPromptCapsule {
  const effectivePromptEnv = promptEnv ?? process.env;
  const capsule: AgentExecutionPromptCapsule = {
    version: "locus.agent.prompt.v1",
    agentName: request.agent.name,
    ...(request.capabilityMode === undefined ? {} : { capabilityMode: request.capabilityMode }),
    task: request.task,
    projectRoot: request.projectRoot ?? "",
    workingDirectory: request.workingDirectory ?? request.projectRoot ?? "",
    allowedTools: [...request.allowedTools],
    maxTurns: request.maxTurns,
    depth: request.depth,
    maxDepth: request.maxDepth,
  };
  if (request.agent.filePath !== undefined) capsule.agentDefinitionPath = request.agent.filePath;
  if (request.modelRoleResolution !== undefined)
    capsule.modelRole = modelRoleResolutionRecord(request.modelRoleResolution);
  const agentSystemPrompt = buildAgentSystemPrompt(request, {
    diagnostics,
    env: effectivePromptEnv,
    suppressContextExtras: request.capabilityMode === "tool-free",
  });
  if (agentSystemPrompt !== undefined) capsule.agentSystemPrompt = agentSystemPrompt;
  if (diagnostics.length > 0) capsule.contextDiagnostics = [...diagnostics];
  const parentContextText = assembleParentContext(request.parentContext);
  if (parentContextText !== undefined) capsule.parentContext = parentContextText;
  return capsule;
}

export function assembleParentContext(
  parentContext: AgentParentContext | undefined,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | undefined {
  if (parentContext === undefined) return undefined;
  const parts: string[] = [];
  if (parentContext.inline !== undefined && parentContext.inline.length > 0) parts.push(parentContext.inline);
  if (parentContext.artifactPath !== undefined && parentContext.artifactPath.length > 0) {
    try {
      const artifactText = readFile(parentContext.artifactPath);
      if (artifactText.length > 0) parts.push(artifactText);
    } catch {
      // Explicit parent context is optional; a missing artifact should not block the child run.
    }
  }
  if (parts.length === 0) return undefined;
  return clampParentContext(parts.join("\n---\n"));
}

function clampParentContext(text: string): string {
  const suffix = "\n...[parent context truncated]";
  const maxBytes = OUTPUT_DEFAULTS.subagentSummaryBytes;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const targetBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > targetBytes) end = Math.floor(end * 0.9);
  while (end < text.length && Buffer.byteLength(text.slice(0, end + 1), "utf8") <= targetBytes) end += 1;
  return `${text.slice(0, end)}${suffix}`;
}

export function formatAgentKickoffPrompt(capsule: AgentExecutionPromptCapsule): string {
  const lines = [
    "Run the requested Locus agent task in this replacement session.",
    "",
    "Prompt capsule:",
    JSON.stringify(capsule, null, 2),
  ];
  if (capsule.parentContext !== undefined) {
    lines.push("", "Parent-provided context (explicit, read-only):", capsule.parentContext);
  }
  lines.push(
    "",
    "Do the work, then reply to the parent runtime in plain text. Your exact final non-empty message is the result.",
    "Do not wrap the result in JSON and do not add a machine-readable result envelope.",
    "If the prompt capsule includes agentSystemPrompt, treat it as this child agent's operating instructions.",
  );
  return lines.join("\n");
}

export function parseAgentText(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (text.trim() === "") return { ok: false, reason: "Agent result text is empty." };
  return { ok: true, text };
}
