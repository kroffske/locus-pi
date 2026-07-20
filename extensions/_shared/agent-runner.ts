import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "./pi-api.js";
import { getProjectRoot, getSessionId, getWorkingDirectory } from "./pi-api.js";
import type { AgentDefinition, EvidenceEvaluation } from "./types.js";
import type { CreateSessionInput, MemorySessionStore, SessionRecord } from "./session-core.js";
import { createSessionStore, type SessionStore } from "./runtime-capabilities.js";
import type { ModelRoleResolution } from "./model-settings.js";
import { modelRoleResolutionRecord } from "./model-settings.js";
import type { RuntimeArtifact } from "./artifacts.js";
import { createRuntimeArtifactStore } from "./artifacts.js";

export type AgentRunStatus = "blocked" | "running" | "completed" | "failed" | "cancelled";
export type ApprovalTier = "allow" | "prompt" | "deny";

export interface AgentParentContext {
  inline?: string;
  artifactPath?: string;
}

export interface AgentRunRequest {
  agent: AgentDefinition;
  task: string;
  parentSessionId: string;
  projectRoot?: string;
  workingDirectory?: string;
  maxTurns: number;
  depth: number;
  maxDepth: number;
  allowedTools: string[];
  approvalTier: ApprovalTier;
  modelRoleResolution?: ModelRoleResolution;
  parentContext?: AgentParentContext;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  agentName: string;
  reason: string;
  evidence?: EvidenceEvaluation;
  childSession?: SessionRecord;
  diagnostics: string[];
  lifecycleEntryIds: string[];
  /** Exact non-empty final child message on successful completion. */
  text?: string;
  childOutputStats?: AgentChildOutputStats;
  childTrace?: AgentChildTrace;
  resultArtifact?: RuntimeArtifact;
  worktreePath?: string;
}

export interface AgentChildTrace {
  path: string;
  format: "pi-session-jsonl";
  childSessionId: string;
}

export interface AgentChildOutputStats {
  entryCount: number;
  assistantMessageCount: number;
  assistantToolCallCount: number;
  toolResultCount: number;
  recordedToolCallCount?: number;
  recordedToolResultCount?: number;
  recordedToolNames?: string[];
  transcriptToolBlockCount?: number;
  transcriptToolNames?: string[];
  hasWorkloadProof: boolean;
}

export interface AgentExecutor {
  run(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunResult>;
}

export interface AgentRunBoundaryOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  request: Omit<AgentRunRequest, "parentSessionId" | "projectRoot" | "workingDirectory"> &
    Partial<Pick<AgentRunRequest, "workingDirectory">>;
  sessionStore?: SessionStore;
  executor?: AgentExecutor;
  signal?: AbortSignal;
}

// T-119 PRE-CHECK: getBranch UNREACHABLE
//
// `ctx.sessionManager.getBranch?()` exists only as an optional structural type in
// pi-api.ts. Repo call sites never invoke it, the local test harness does not
// implement it, and this boundary receives no proven parent-turn branch from a
// tool-context `execute()` call. Do not synthesize parent context here: the honest
// ER-4 fork is explicit-artifact / message-passing. A parent flow should write or
// pass the exact context artifact/message it wants the child to read, and the
// child kickoff should reference that explicit payload instead of pretending the
// host supplied conversation history.
export async function executeAgentRunBoundary(options: AgentRunBoundaryOptions): Promise<AgentRunResult> {
  const projectRoot = getProjectRoot(options.ctx);
  const parentSessionId = getSessionId(options.ctx);
  const request: AgentRunRequest = {
    ...options.request,
    parentSessionId,
    projectRoot,
    workingDirectory: options.request.workingDirectory ?? getWorkingDirectory(options.ctx),
  };
  const policyBlock = validateRunPolicy(request);
  if (policyBlock !== undefined) return blockedResult(request, policyBlock, []);

  const store = options.sessionStore ?? createSessionStore({ projectRoot });
  const childSession = createAgentChildSession(store, request);
  const lifecycleEntryIds: string[] = [];
  const startEntry = store.appendEntry(childSession.id, {
    type: "message",
    payload: {
      role: "system",
      content: `Agent run requested for ${request.agent.name}.`,
      metadata: {
        source: "agent-runner",
        agentName: request.agent.name,
        task: request.task,
      },
    },
  });
  lifecycleEntryIds.push(startEntry.id);

  if (options.executor === undefined) {
    const failed = store.appendEntry(request.parentSessionId, {
      type: "child_run",
      payload: {
        childSessionId: childSession.id,
        status: "failed",
        metadata: {
          source: "agent-runner",
          reason: "No agent executor is configured.",
          agentName: request.agent.name,
        },
      },
    });
    lifecycleEntryIds.push(failed.id);
    return writeAgentRunResultArtifact(
      projectRoot,
      request,
      blockedResult(request, "No agent executor is configured.", lifecycleEntryIds, childSession),
    );
  }

  const result = await options.executor.run(request, options.signal ?? new AbortController().signal);
  return writeAgentRunResultArtifact(projectRoot, request, result);
}

export function validateRunPolicy(request: AgentRunRequest): string | undefined {
  if (request.maxTurns < 1 || request.maxTurns > 20) return "maxTurns must be between 1 and 20.";
  if (request.depth < 0) return "depth must be non-negative.";
  if (request.depth >= request.maxDepth) return "Agent run depth limit reached.";
  if (!isAllowedToolSubset(request.agent.allowedTools, request.allowedTools))
    return "Requested tools exceed the agent definition allow-list.";
  return undefined;
}

export function createAgentRunRequest(
  agent: AgentDefinition,
  task: string,
  input: Partial<AgentRunRequest> = {},
): Omit<AgentRunRequest, "parentSessionId" | "projectRoot"> {
  const request: Omit<AgentRunRequest, "parentSessionId" | "projectRoot"> = {
    agent,
    task,
    maxTurns: input.maxTurns ?? 5,
    depth: input.depth ?? 0,
    maxDepth: input.maxDepth ?? 1,
    allowedTools: input.allowedTools ?? agent.allowedTools,
    approvalTier: input.approvalTier ?? "prompt",
  };
  if (input.metadata !== undefined) request.metadata = input.metadata;
  if (input.modelRoleResolution !== undefined) request.modelRoleResolution = input.modelRoleResolution;
  if (input.parentContext !== undefined) request.parentContext = input.parentContext;
  if (input.workingDirectory !== undefined) request.workingDirectory = input.workingDirectory;
  return request;
}

function createAgentChildSession(store: MemorySessionStore, request: AgentRunRequest): SessionRecord {
  if (store.getSession(request.parentSessionId) === undefined) {
    const parentInput: CreateSessionInput = {
      id: request.parentSessionId,
      metadata: { source: "agent-runner" },
    };
    if (request.projectRoot !== undefined) parentInput.projectRoot = request.projectRoot;
    if (request.workingDirectory !== undefined) parentInput.workingDirectory = request.workingDirectory;
    store.createSession(parentInput);
  }
  const childInput: Omit<CreateSessionInput, "parentSessionId"> = {
    metadata: {
      source: "agent-runner",
      agentName: request.agent.name,
      maxTurns: request.maxTurns,
      depth: request.depth,
      maxDepth: request.maxDepth,
      ...(request.modelRoleResolution === undefined
        ? {}
        : { modelRole: modelRoleResolutionRecord(request.modelRoleResolution) }),
    },
  };
  if (request.projectRoot !== undefined) childInput.projectRoot = request.projectRoot;
  if (request.workingDirectory !== undefined) childInput.workingDirectory = request.workingDirectory;
  return store.createChildSession(request.parentSessionId, childInput);
}

function blockedResult(
  request: AgentRunRequest,
  reason: string,
  lifecycleEntryIds: string[],
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "blocked",
    agentName: request.agent.name,
    reason,
    diagnostics: [reason],
    lifecycleEntryIds,
  };
  if (childSession !== undefined) result.childSession = childSession;
  return result;
}

export function writeAgentRunResultArtifact(
  projectRoot: string,
  request: AgentRunRequest,
  result: AgentRunResult,
): AgentRunResult {
  if (result.resultArtifact !== undefined) return result;
  const store = createRuntimeArtifactStore(projectRoot);
  const body = {
    version: "locus.agent.run-result.v1",
    status: result.status,
    reason: result.reason,
    agentName: result.agentName,
    parentSessionId: request.parentSessionId,
    childSessionId: result.childSession?.id,
    projectRoot: request.projectRoot,
    workingDirectory: request.workingDirectory,
    maxTurns: request.maxTurns,
    depth: request.depth,
    maxDepth: request.maxDepth,
    allowedTools: request.allowedTools,
    modelRole:
      request.modelRoleResolution === undefined ? undefined : modelRoleResolutionRecord(request.modelRoleResolution),
    diagnostics: result.diagnostics,
    lifecycleEntryIds: result.lifecycleEntryIds,
    evidence: result.evidence,
    text: result.text,
    childOutputStats: result.childOutputStats,
    childTrace: result.childTrace,
    metadata: request.metadata,
    worktreePath: result.worktreePath ?? request.workingDirectory,
  };
  try {
    const artifact = store.writeArtifact({
      id: `agent-run-${result.childSession?.id ?? randomUUID()}`,
      kind: "json",
      content: `${JSON.stringify(body, null, 2)}\n`,
      sessionId: request.parentSessionId,
      title: `Agent run result: ${result.agentName}`,
      metadata: {
        source: "agent-runner",
        agentName: result.agentName,
        status: result.status,
        childSessionId: result.childSession?.id,
        modelRole:
          request.modelRoleResolution === undefined
            ? undefined
            : modelRoleResolutionRecord(request.modelRoleResolution),
      },
    });
    return { ...result, resultArtifact: artifact };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...result, diagnostics: [...result.diagnostics, `Agent run result artifact was not written: ${reason}`] };
  }
}

function isAllowedToolSubset(agentTools: string[], requestedTools: string[]): boolean {
  if (agentTools.includes("*")) return true;
  const allowed = new Set(agentTools);
  return requestedTools.every((tool) => allowed.has(tool));
}
