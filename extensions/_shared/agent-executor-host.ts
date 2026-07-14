import { readFileSync } from "node:fs";
import type { AgentChildOutputStats, AgentExecutor, AgentParentContext, AgentRunRequest, AgentRunResult } from "./agent-runner.js";
import type { ModelRoleResolutionRecord } from "./model-settings.js";
import { modelRoleResolutionRecord } from "./model-settings.js";
import type {
  ExtensionCommandContext,
  ReplacementSessionContext,
  ReplacementSessionEntryLike,
  NewSessionResultLike,
} from "./pi-api.js";
import type { SessionRecord } from "./session-core.js";
import { getAgentWorkloadProof } from "./agent-workload-proof.js";
import { buildAgentSystemPrompt } from "./agent-system-prompt.js";
import { OUTPUT_DEFAULTS } from "./types.js";

export const AGENT_RESULT_MARKER = "LOCUS_AGENT_RESULT_V1";

export interface AgentExecutionPromptCapsule {
  version: "locus.agent.prompt.v1";
  agentName: string;
  agentDefinitionPath?: string;
  task: string;
  projectRoot: string;
  workingDirectory: string;
  allowedTools: string[];
  maxTurns: number;
  depth: number;
  maxDepth: number;
  modelRole?: ModelRoleResolutionRecord;
  expectedResultMarker: typeof AGENT_RESULT_MARKER;
  agentSystemPrompt?: string;
  contextDiagnostics?: string[];
  parentContext?: string;
}

export interface AgentStructuredResult {
  version: "locus.agent.result.v1";
  status: "completed" | "failed" | "cancelled";
  summary: string;
  result?: unknown;
  output?: unknown;
  diagnostics?: string[];
  artifacts?: Array<{ path: string; kind?: string; title?: string }>;
}

export interface AgentReplacementSessionRunInput {
  request: AgentRunRequest;
  promptCapsule?: AgentExecutionPromptCapsule;
  kickoffPrompt?: string;
  onSessionReplaced?: () => void;
  onChildOutput?: (output: AgentReplacementSessionRunOutput, replacementCtx: ReplacementSessionContext) => Promise<void> | void;
}

export interface AgentReplacementSessionRunOutput {
  status: "blocked" | "completed" | "failed" | "cancelled";
  reason: string;
  promptCapsule: AgentExecutionPromptCapsule;
  result?: AgentStructuredResult;
  childSessionId?: string;
  diagnostics: string[];
  entries: ReplacementSessionEntryLike[];
}

export interface AgentReplacementSessionHost {
  kind: "replacement-session";
  available(ctx: unknown): boolean;
  runInChildSession(input: AgentReplacementSessionRunInput, signal: AbortSignal): Promise<AgentReplacementSessionRunOutput>;
}

export interface AgentReplacementSessionExecutorOptions {
  onSessionReplaced?: () => void;
  onChildResult?: (result: AgentRunResult, replacementCtx: ReplacementSessionContext) => Promise<void> | void;
  promptEnv?: NodeJS.ProcessEnv;
}

export function createAgentReplacementSessionExecutor(ctx: ExtensionCommandContext, options: AgentReplacementSessionExecutorOptions = {}): AgentExecutor {
  const host = createAgentReplacementSessionHost(ctx);
  return {
    async run(request, signal) {
      const promptCapsule = options.promptEnv === undefined
        ? undefined
        : createAgentExecutionPromptCapsule(request, [], options.promptEnv);
      const input: AgentReplacementSessionRunInput = {
        request,
        ...(promptCapsule === undefined ? {} : { promptCapsule }),
        async onChildOutput(childOutput, replacementCtx) {
          await options.onChildResult?.(mapReplacementSessionOutputToRunResult(request, childOutput), replacementCtx);
        },
      };
      if (options.onSessionReplaced !== undefined) input.onSessionReplaced = options.onSessionReplaced;
      const output = await host.runInChildSession(input, signal);
      return mapReplacementSessionOutputToRunResult(request, output);
    },
  };
}

export function createAgentExecutionPromptCapsule(request: AgentRunRequest, diagnostics: string[] = [], promptEnv: NodeJS.ProcessEnv | undefined = process.env): AgentExecutionPromptCapsule {
  const effectivePromptEnv = promptEnv ?? process.env;
  const capsule: AgentExecutionPromptCapsule = {
    version: "locus.agent.prompt.v1",
    agentName: request.agent.name,
    task: request.task,
    projectRoot: request.projectRoot ?? "",
    workingDirectory: request.workingDirectory ?? request.projectRoot ?? "",
    allowedTools: [...request.allowedTools],
    maxTurns: request.maxTurns,
    depth: request.depth,
    maxDepth: request.maxDepth,
    expectedResultMarker: AGENT_RESULT_MARKER,
  };
  if (request.agent.filePath !== undefined) capsule.agentDefinitionPath = request.agent.filePath;
  if (request.modelRoleResolution !== undefined) capsule.modelRole = modelRoleResolutionRecord(request.modelRoleResolution);
  const agentSystemPrompt = buildAgentSystemPrompt(request, { diagnostics, env: effectivePromptEnv });
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
    "Do the work, then reply to the parent runtime in plain text. Plain prose IS the result: the runtime returns your final message to the caller as-is and treats it as completed. Do not wrap it in JSON.",
    "If the prompt capsule includes agentSystemPrompt, treat it as this child agent's operating instructions.",
    `Structured output is OPT-IN — only if you must report a non-success outcome or return machine-readable fields, end your message with ${AGENT_RESULT_MARKER} followed by JSON { version: "locus.agent.result.v1", status, summary, result?, output?, diagnostics?, artifacts? }, where status is exactly one of "completed", "failed", or "cancelled". If you emit that envelope, make it valid JSON; otherwise just answer in plain text.`,
  );
  return lines.join("\n");
}

export function createAgentReplacementSessionHost(ctx: ExtensionCommandContext): AgentReplacementSessionHost {
  return {
    kind: "replacement-session",
    available(candidate: unknown): boolean {
      return isCommandContextWithNewSession(candidate);
    },
    async runInChildSession(input, signal) {
      const promptCapsule = input.promptCapsule ?? createAgentExecutionPromptCapsule(input.request);
      const kickoffPrompt = input.kickoffPrompt ?? formatAgentKickoffPrompt(promptCapsule);
      if (!isCommandContextWithNewSession(ctx)) {
        return hostBlocked(promptCapsule, "Replacement-session host is unavailable.");
      }
      if (signal.aborted) return hostCancelled(promptCapsule, "Agent run was cancelled before child session creation.");

      try {
        let childOutput: AgentReplacementSessionRunOutput | undefined;
        let sessionReplaced = false;
        const markSessionReplaced = () => {
          if (sessionReplaced) return;
          sessionReplaced = true;
          input.onSessionReplaced?.();
        };
        const sessionResult = await ctx.newSession({
          parentSession: input.request.parentSessionId,
          setup(sessionManager) {
            markSessionReplaced();
            installReplacementPersonaPrompt(sessionManager, promptCapsule.agentSystemPrompt);
          },
          async withSession(replacementCtx) {
            markSessionReplaced();
            childOutput = await runReplacementSession(replacementCtx, input, promptCapsule, kickoffPrompt, signal);
          },
        });
        if (isNewSessionCancelledResult(sessionResult)) {
          return hostCancelled(promptCapsule, sessionResult.reason ?? "Replacement-session creation was cancelled.");
        }
        if (childOutput !== undefined) return childOutput;
        if (isAgentReplacementSessionRunOutput(sessionResult)) return sessionResult;
        return {
          status: "failed",
          reason: "Replacement session finished without a captured child result.",
          promptCapsule,
          diagnostics: ["Replacement session finished without a captured child result."],
          entries: [],
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          reason,
          promptCapsule,
          diagnostics: [reason],
          entries: [],
        };
      }
    },
  };
}

interface ReplacementPersonaSetupMessage {
  role: "user";
  content: string;
  timestamp: number;
}

function installReplacementPersonaPrompt(sessionManager: unknown, systemPrompt: string | undefined): void {
  if (systemPrompt === undefined) return;
  if (!isRecord(sessionManager) || typeof sessionManager.appendMessage !== "function") return;
  const message: ReplacementPersonaSetupMessage = {
    role: "user",
    content: ["Locus child-agent operating instructions:", "", systemPrompt].join("\n"),
    timestamp: Date.now(),
  };
  (sessionManager as { appendMessage(message: ReplacementPersonaSetupMessage): unknown }).appendMessage(message);
}

async function runReplacementSession(
  replacementCtx: ReplacementSessionContext,
  input: AgentReplacementSessionRunInput,
  promptCapsule: AgentExecutionPromptCapsule,
  kickoffPrompt: string,
  signal: AbortSignal,
): Promise<AgentReplacementSessionRunOutput> {
  if (signal.aborted) return finishReplacementSessionRun(input, replacementCtx, hostCancelled(promptCapsule, "Agent run was cancelled before child session kickoff."));
  if (typeof replacementCtx.sendUserMessage !== "function") {
    return finishReplacementSessionRun(input, replacementCtx, hostBlocked(promptCapsule, "Replacement session cannot receive user messages."));
  }
  await replacementCtx.sendUserMessage(kickoffPrompt, { source: "locus-pi-agent-executor" });
  if (typeof replacementCtx.waitForIdle === "function") await replacementCtx.waitForIdle({ signal });
  const entries = await readReplacementEntries(replacementCtx);
  const parsed = parseAgentStructuredResultFromEntries(entries);
  const childSessionId = childSessionIdOutput(replacementCtx).childSessionId;
  const outputStats = summarizeReplacementSessionEntries(entries, childSessionId, promptCapsule.allowedTools, promptCapsule.projectRoot);
  if (!parsed.ok) {
    return finishReplacementSessionRun(input, replacementCtx, {
      status: "failed",
      reason: parsed.reason,
      promptCapsule,
      diagnostics: [parsed.reason],
      entries,
      ...childSessionIdOutput(replacementCtx),
    });
  }
  return finishReplacementSessionRun(input, replacementCtx, {
    status: parsed.result.status,
    reason: parsed.result.summary,
    promptCapsule,
    result: parsed.result,
    diagnostics: parsed.result.diagnostics ?? [],
    entries,
    ...(childSessionId === undefined ? {} : { childSessionId }),
  });
}

async function finishReplacementSessionRun(
  input: AgentReplacementSessionRunInput,
  replacementCtx: ReplacementSessionContext,
  output: AgentReplacementSessionRunOutput,
): Promise<AgentReplacementSessionRunOutput> {
  await input.onChildOutput?.(output, replacementCtx);
  return output;
}

export function parseAgentStructuredResultFromEntries(entries: ReplacementSessionEntryLike[]): { ok: true; result: AgentStructuredResult } | { ok: false; reason: string } {
  for (const entry of entries.slice().reverse()) {
    const text = extractEntryText(entry);
    if (text === undefined) continue;
    const parsed = parseAgentStructuredResult(text);
    if (parsed.ok) return parsed;
    if (parsed.reason !== "Agent result text is empty.") return parsed;
  }
  return { ok: false, reason: "Agent result text is empty." };
}

export function parseAgentStructuredResult(text: string): { ok: true; result: AgentStructuredResult } | { ok: false; reason: string } {
  const markerIndex = findResultMarkerIndex(text);
  const normalized = text.trim();
  if (normalized.length === 0) return { ok: false, reason: "Agent result text is empty." };
  if (markerIndex < 0) {
    const rawJson = parseRawStructuredJson(normalized);
    if (rawJson.ok) return rawJson;
    return wrapPlainTextResult(normalized);
  }
  const payload = normalized.slice(markerIndex + AGENT_RESULT_MARKER.length).trim();
  // The structured envelope is OPT-IN, not required: an agent does its work and
  // returns text. We honor a VALID envelope when the model emits one (so a child
  // can still self-report failed/diagnostics/output), but a botched envelope must
  // never hard-fail the run — we fall back to wrapping what the child actually
  // said as a completed plain-text result. Honesty is enforced by workload proof
  // (tool activity), not by the envelope's JSON being well-formed.
  const preMarker = normalized.slice(0, markerIndex).trim();
  const fallback = () => wrapPlainTextResult(preMarker.length > 0 ? preMarker : payload.length > 0 ? payload : normalized);
  if (payload.length === 0) return fallback();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return fallback();
  }
  const validated = validateAgentStructuredResult(parsed);
  return validated.ok ? validated : fallback();
}

function parseRawStructuredJson(text: string): { ok: true; result: AgentStructuredResult } | { ok: false; reason: string } {
  if (!text.startsWith("{")) return { ok: false, reason: "Agent result is not structured JSON." };
  try {
    return validateAgentStructuredResult(JSON.parse(text) as unknown);
  } catch {
    return { ok: false, reason: "Agent result is not structured JSON." };
  }
}

function wrapPlainTextResult(text: string): { ok: true; result: AgentStructuredResult } {
  return {
    ok: true,
    result: {
      version: "locus.agent.result.v1",
      status: "completed",
      summary: summarizePlainTextResult(text),
      result: text,
    },
  };
}

function summarizePlainTextResult(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? text.trim();
  return firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 157)}...`;
}

function mergePromptDiagnostics(promptCapsule: AgentExecutionPromptCapsule, diagnostics: string[]): string[] {
  if (promptCapsule.contextDiagnostics === undefined || promptCapsule.contextDiagnostics.length === 0) return diagnostics;
  return [...promptCapsule.contextDiagnostics, ...diagnostics];
}

export function mapReplacementSessionOutputToRunResult(request: AgentRunRequest, output: AgentReplacementSessionRunOutput): AgentRunResult {
  const result: AgentRunResult = {
    status: output.status,
    agentName: request.agent.name,
    reason: output.reason,
    diagnostics: mergePromptDiagnostics(output.promptCapsule, output.diagnostics),
    lifecycleEntryIds: [],
    childOutputStats: summarizeReplacementSessionEntries(output.entries, output.childSessionId, output.promptCapsule.allowedTools, request.projectRoot),
  };
  if (output.result !== undefined) result.structuredResult = output.result;
  if (output.childSessionId !== undefined) result.childSession = createReplacementSessionRecord(request, output.childSessionId);
  return result;
}

function summarizeReplacementSessionEntries(entries: ReplacementSessionEntryLike[], sessionId?: string, allowedTools: string[] = [], projectRoot?: string): AgentChildOutputStats {
  let assistantMessageCount = 0;
  let assistantToolCallCount = 0;
  let toolResultCount = 0;
  for (const entry of entries) {
    const role = entry.role ?? (isRecord(entry.message) ? entry.message.role : undefined) ?? (isRecord(entry.payload) ? entry.payload.role : undefined);
    if (role === "assistant") assistantMessageCount += 1;
    assistantToolCallCount += countToolCalls(entry);
    toolResultCount += countToolResults(entry);
  }
  const recorded = getAgentWorkloadProof(sessionId, projectRoot);
  const recordedToolCallCount = recorded?.toolCallCount ?? 0;
  const recordedToolResultCount = recorded?.toolResultCount ?? 0;
  const transcriptProof = countTranscriptToolBlocks(entries, allowedTools);
  return {
    entryCount: entries.length,
    assistantMessageCount,
    assistantToolCallCount,
    toolResultCount,
    ...(recorded === undefined ? {} : {
      recordedToolCallCount,
      recordedToolResultCount,
      recordedToolNames: recorded.toolNames,
    }),
    ...(transcriptProof.count === 0 ? {} : {
      transcriptToolBlockCount: transcriptProof.count,
      transcriptToolNames: transcriptProof.toolNames,
    }),
    hasWorkloadProof: assistantToolCallCount > 0 || toolResultCount > 0 || transcriptProof.count > 0,
  };
}

async function readReplacementEntries(ctx: ReplacementSessionContext): Promise<ReplacementSessionEntryLike[]> {
  if (ctx.sessionManager === undefined) return [];
  const entries = await ctx.sessionManager.getEntries({ limit: 500 });
  return entries.slice(-500);
}

function findResultMarkerIndex(text: string): number {
  const trimmed = text.trim();
  if (trimmed.startsWith(AGENT_RESULT_MARKER)) return text.indexOf(AGENT_RESULT_MARKER);
  const lineMatch = new RegExp(`(?:^|\\n)\\s*${AGENT_RESULT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(text);
  return lineMatch?.index === undefined ? -1 : lineMatch.index + lineMatch[0].lastIndexOf(AGENT_RESULT_MARKER);
}

function isCommandContextWithNewSession(ctx: unknown): ctx is ExtensionCommandContext & Required<Pick<ExtensionCommandContext, "newSession">> {
  return isRecord(ctx) && typeof ctx.newSession === "function";
}

function validateAgentStructuredResult(value: unknown): { ok: true; result: AgentStructuredResult } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "Structured agent result must be an object." };
  if (value.version !== "locus.agent.result.v1") return { ok: false, reason: "Structured agent result has unsupported version." };
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled") {
    return { ok: false, reason: "Structured agent result has unsupported status." };
  }
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    return { ok: false, reason: "Structured agent result summary is required." };
  }

  const result: AgentStructuredResult = {
    version: "locus.agent.result.v1",
    status: value.status,
    summary: value.summary,
  };
  if ("result" in value) result.result = value.result;
  if ("output" in value) result.output = value.output;
  if ("diagnostics" in value) {
    const diagnostics = normalizeDiagnostics(value.diagnostics);
    if (diagnostics === undefined) return { ok: false, reason: "Structured agent result diagnostics are invalid." };
    result.diagnostics = diagnostics;
  }
  if ("artifacts" in value) {
    const artifacts = normalizeArtifacts(value.artifacts);
    if (artifacts === undefined) return { ok: false, reason: "Structured agent result artifacts are invalid." };
    result.artifacts = artifacts;
  }
  return { ok: true, result };
}

function extractEntryText(entry: ReplacementSessionEntryLike): string | undefined {
  if (typeof entry.content === "string") return entry.content;
  if (typeof entry.text === "string") return entry.text;
  const messageText = extractTextFromContent(isRecord(entry.message) ? entry.message.content : undefined);
  if (messageText !== undefined) return messageText;
  if (isRecord(entry.payload) && typeof entry.payload.content === "string") return entry.payload.content;
  if (isRecord(entry.data) && typeof entry.data.content === "string") return entry.data.content;
  const payloadText = extractTextFromContent(isRecord(entry.payload) ? entry.payload.content : undefined);
  if (payloadText !== undefined) return payloadText;
  const dataText = extractTextFromContent(isRecord(entry.data) ? entry.data.content : undefined);
  if (dataText !== undefined) return dataText;
  return undefined;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const textParts = content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    if (typeof part.content === "string") return [part.content];
    return [];
  });
  return textParts.length === 0 ? undefined : textParts.join("\n");
}

function hostBlocked(promptCapsule: AgentExecutionPromptCapsule, reason: string): AgentReplacementSessionRunOutput {
  return {
    status: "blocked",
    reason,
    promptCapsule,
    diagnostics: [reason],
    entries: [],
  };
}

function hostCancelled(promptCapsule: AgentExecutionPromptCapsule, reason: string): AgentReplacementSessionRunOutput {
  return {
    status: "cancelled",
    reason,
    promptCapsule,
    diagnostics: [reason],
    entries: [],
  };
}

function createReplacementSessionRecord(request: AgentRunRequest, childSessionId: string): SessionRecord {
  const session: SessionRecord = {
    id: childSessionId,
    createdAt: "replacement-session",
    parentSessionId: request.parentSessionId,
    metadata: {
      source: "replacement-session-host",
      agentName: request.agent.name,
      maxTurns: request.maxTurns,
      depth: request.depth,
      maxDepth: request.maxDepth,
    },
  };
  if (request.projectRoot !== undefined) session.projectRoot = request.projectRoot;
  if (request.workingDirectory !== undefined) session.workingDirectory = request.workingDirectory;
  return session;
}

function childSessionIdOutput(ctx: ReplacementSessionContext): { childSessionId?: string } {
  const childSessionId = getReplacementSessionId(ctx);
  return childSessionId === undefined ? {} : { childSessionId };
}

function getReplacementSessionId(ctx: ReplacementSessionContext): string | undefined {
  if (ctx.session?.id !== undefined) return ctx.session.id;
  const manager = ctx.sessionManager;
  if (manager !== undefined && typeof manager.getSessionId === "function") return manager.getSessionId();
  return undefined;
}

function countToolCalls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countToolCalls(item), 0);
  if (!isRecord(value)) return 0;
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "tool_calls" || key === "toolCalls") && Array.isArray(item)) {
      count += item.length;
      continue;
    }
    count += countToolCalls(item);
  }
  return count;
}

function countToolResults(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countToolResults(item), 0);
  if (!isRecord(value)) return 0;
  const role = typeof value.role === "string" ? value.role : undefined;
  const type = typeof value.type === "string" ? value.type : typeof value.customType === "string" ? value.customType : undefined;
  if (role === "tool" || type === "tool_result" || type === "toolResult") return 1;
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "tool_results" || key === "toolResults") && Array.isArray(item)) {
      count += item.length;
      continue;
    }
    count += countToolResults(item);
  }
  return count;
}

function countTranscriptToolBlocks(entries: ReplacementSessionEntryLike[], allowedTools: string[]): { count: number; toolNames: string[] } {
  const names = allowedTools.filter((name) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name));
  if (names.length === 0) return { count: 0, toolNames: [] };
  let count = 0;
  const found = new Set<string>();
  for (const entry of entries) {
    const text = extractEntryText(entry);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const name = lines[index]?.trim();
      if (name === undefined || !names.includes(name)) continue;
      const next = nextNonEmptyLine(lines, index + 1);
      if (next === undefined || next.startsWith(`Tool ${name} not found`)) continue;
      count += 1;
      found.add(name);
    }
  }
  return { count, toolNames: [...found].sort() };
}

function nextNonEmptyLine(lines: string[], start: number): string | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line !== "") return line;
  }
  return undefined;
}

function normalizeDiagnostics(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(formatDiagnosticItem);
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return undefined;
  return Object.entries(value).map(([key, item]) => `${key}: ${formatDiagnosticItem(item)}`);
}

function formatDiagnosticItem(item: unknown): string {
  if (typeof item === "string") return item;
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function normalizeArtifacts(value: unknown): Array<{ path: string; kind?: string; title?: string }> | undefined {
  if (Array.isArray(value)) return normalizeArtifactArray(value);
  if (!isRecord(value)) return undefined;
  const artifacts: Array<{ path: string; kind?: string; title?: string }> = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && looksLikePath(item)) artifacts.push({ path: item, title: key });
    if (Array.isArray(item)) {
      for (const nested of item) {
        if (typeof nested === "string" && looksLikePath(nested)) artifacts.push({ path: nested, title: key });
      }
    }
  }
  return artifacts;
}

function normalizeArtifactArray(value: unknown[]): Array<{ path: string; kind?: string; title?: string }> | undefined {
  const artifacts: Array<{ path: string; kind?: string; title?: string }> = [];
  for (const item of value) {
    if (isArtifact(item)) {
      artifacts.push(item);
      continue;
    }
    if (typeof item === "string" && looksLikePath(item)) {
      artifacts.push({ path: item });
      continue;
    }
    return undefined;
  }
  return artifacts;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".");
}

function isArtifact(value: unknown): value is { path: string; kind?: string; title?: string } {
  if (!isRecord(value) || typeof value.path !== "string") return false;
  if ("kind" in value && typeof value.kind !== "string") return false;
  if ("title" in value && typeof value.title !== "string") return false;
  return true;
}

function isNewSessionCancelledResult(value: unknown): value is NewSessionResultLike & { cancelled: true } {
  return isRecord(value) && value.cancelled === true;
}

function isAgentReplacementSessionRunOutput(value: unknown): value is AgentReplacementSessionRunOutput {
  if (!isRecord(value)) return false;
  if (value.status !== "blocked" && value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled") return false;
  return typeof value.reason === "string" && Array.isArray(value.diagnostics) && Array.isArray(value.entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
