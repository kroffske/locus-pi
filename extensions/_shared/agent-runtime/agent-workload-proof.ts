import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EventPayload, ExtensionAPI, ExtensionContext } from "../host/pi-api.js";
import { getProjectRoot, getSessionId } from "../host/pi-api.js";

export interface AgentWorkloadProof {
  toolCallCount: number;
  toolResultCount: number;
  toolNames: string[];
}

const proofBySession = new Map<string, AgentWorkloadProof>();
const registeredApis = new WeakSet<ExtensionAPI>();

export function registerAgentWorkloadProofHooks(pi: ExtensionAPI): void {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);
  pi.on("tool_call", (event, ctx) => {
    recordWorkloadEvent(event, ctx, "call");
  });
  pi.on("tool_result", (event, ctx) => {
    recordWorkloadEvent(event, ctx, "result");
  });
}

export function getAgentWorkloadProof(
  sessionId: string | undefined,
  projectRoot?: string,
): AgentWorkloadProof | undefined {
  if (sessionId === undefined) return undefined;
  const proof = proofBySession.get(sessionId);
  const persisted = readPersistedProof(projectRoot, sessionId);
  const merged = mergeProof(proof, persisted);
  if (merged === undefined) return undefined;
  return {
    toolCallCount: merged.toolCallCount,
    toolResultCount: merged.toolResultCount,
    toolNames: [...merged.toolNames],
  };
}

export function writeAgentWorkloadProof(ctx: ExtensionContext, toolName: string): string {
  const projectRoot = getProjectRoot(ctx);
  const sessionId = getSessionId(ctx);
  const proof = mergeProof(getAgentWorkloadProof(sessionId, projectRoot), {
    toolCallCount: 1,
    toolResultCount: 1,
    toolNames: [toolName],
  }) ?? { toolCallCount: 1, toolResultCount: 1, toolNames: [toolName] };
  proofBySession.set(sessionId, proof);
  const filePath = proofPath(projectRoot, sessionId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ version: "locus.agent.workload-proof.v1", sessionId, ...proof }, null, 2)}\n`,
    "utf8",
  );
  return filePath;
}

function recordWorkloadEvent(event: EventPayload, ctx: ExtensionContext, kind: "call" | "result"): void {
  const sessionId = event.sessionId ?? getSessionId(ctx);
  if (sessionId === "unknown-session") return;
  const current = proofBySession.get(sessionId) ?? { toolCallCount: 0, toolResultCount: 0, toolNames: [] };
  if (kind === "call") current.toolCallCount += 1;
  if (kind === "result") current.toolResultCount += 1;
  if (typeof event.toolName === "string" && event.toolName !== "" && !current.toolNames.includes(event.toolName)) {
    current.toolNames.push(event.toolName);
  }
  proofBySession.set(sessionId, current);
}

function readPersistedProof(projectRoot: string | undefined, sessionId: string): AgentWorkloadProof | undefined {
  if (projectRoot === undefined || projectRoot === "") return undefined;
  try {
    const parsed = JSON.parse(readFileSync(proofPath(projectRoot, sessionId), "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      toolCallCount: typeof parsed.toolCallCount === "number" ? parsed.toolCallCount : 0,
      toolResultCount: typeof parsed.toolResultCount === "number" ? parsed.toolResultCount : 0,
      toolNames: Array.isArray(parsed.toolNames)
        ? parsed.toolNames.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return undefined;
  }
}

function proofPath(projectRoot: string, sessionId: string): string {
  return path.join(projectRoot, ".locus", "runtime", "agent-workload-proof", `${safeFileName(sessionId)}.json`);
}

function mergeProof(
  left: AgentWorkloadProof | undefined,
  right: AgentWorkloadProof | undefined,
): AgentWorkloadProof | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    toolCallCount: Math.max(left.toolCallCount, right.toolCallCount),
    toolResultCount: Math.max(left.toolResultCount, right.toolResultCount),
    toolNames: [...new Set([...left.toolNames, ...right.toolNames])].sort(),
  };
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
