import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "../host/pi-api.js";
import { getProjectRoot, getSessionId, getWorkingDirectory } from "../host/pi-api.js";
import type { AgentDefinition, AgentFailureCause, EvidenceEvaluation } from "../types.js";
import type { CreateSessionInput, MemorySessionStore, SessionRecord } from "../runtime/session-core.js";
import { createSessionStore, type SessionStore } from "../runtime/runtime-capabilities.js";
import type { ModelRoleResolution } from "../model/model-settings.js";
import { modelRoleResolutionRecord } from "../model/model-settings.js";
import type { RuntimeArtifact } from "../runtime/artifacts.js";
import { FileRuntimeArtifactStore, createRuntimeArtifactStore } from "../runtime/artifacts.js";
import type { RepositoryCheckScripts } from "./agent-read-only-policy.js";

export type AgentRunStatus = "blocked" | "running" | "completed" | "failed" | "cancelled";
export type ApprovalTier = "allow" | "prompt" | "deny";

/**
 * The closed failure-cause list, owned by this envelope and defined in the zero-import
 * `types.ts` so the host-agnostic workflow core can validate against the same value
 * without importing a module that reaches for `node:fs`. Re-exported here because this
 * is the envelope that first carries it.
 */
export { AGENT_FAILURE_CAUSES } from "../types.js";
export type { AgentFailureCause } from "../types.js";

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
  /**
   * Set when the caller declared a tier that no layer assigns, so the child ran on
   * the parent session model instead. Request-side by construction: the caller knows
   * it before the child starts, and the run-result artifact is written from the
   * request, so this is the only shape that reaches the artifact at all.
   */
  modelRoleFallback?: string;
  parentContext?: AgentParentContext;
  /** Exact package scripts frozen by a workflow before any writer child runs. */
  repositoryCheckScripts?: RepositoryCheckScripts;
  metadata?: Record<string, unknown>;
}

/**
 * Recorded when a child session was created but the host exposes no model on it —
 * an older peer, or a structural mock. A literal value beats an absent field
 * because absence is ambiguous, and it beats echoing the request because a request
 * repeated back is not evidence of anything.
 */
export const EXECUTED_MODEL_UNAVAILABLE = "unavailable";

export interface AgentRunResult {
  status: AgentRunStatus;
  agentName: string;
  reason: string;
  /** Why this run did not complete. Absent on success, and on results written before
   *  the field existed — a reader treats absence as `unclassified`, never as retryable. */
  failureCause?: AgentFailureCause;
  /**
   * What the CHILD SESSION reported it ran on, read back from the host after the
   * session was created, formatted as `provider/id`. `EXECUTED_MODEL_UNAVAILABLE`
   * when the host exposes nothing; absent when no child session was ever created.
   * Never derived from the requested selector.
   */
  executedModel?: string;
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
  /** Explicit workflow-call-local destination for the result envelope. */
  resultArtifactsDir?: string;
  /**
   * Asked once, after the executor returns and BEFORE the envelope is written: does the
   * CALLER own a final transport outcome the host cannot observe?
   *
   * A caller that aborts the child itself — the workflow bridge's per-call `timeoutMs` is
   * the only one today — knows a fact the host cannot: the host sees a cancellation and
   * says so honestly, while the caller knows it fired the fuse. A late executor can even
   * return `completed` after that fuse fired. Without this finalizer the envelope can
   * durably record a cancellation — or a success — while the caller's journal records a
   * call timeout. The hook returns the exact result the envelope must persist.
   */
  finalizeResult?: (result: AgentRunResult) => AgentRunResult;
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
  if (policyBlock !== undefined) return blockedResult(request, policyBlock, "run-policy-blocked", []);

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
      blockedResult(request, "No agent executor is configured.", "run-policy-blocked", lifecycleEntryIds, childSession),
      options.resultArtifactsDir,
    );
  }

  const result = await options.executor.run(request, options.signal ?? new AbortController().signal);
  // Finalized before the envelope is written, so the durable record and the caller's
  // journal cannot disagree about one transport outcome.
  const finalized = options.finalizeResult?.(result) ?? result;
  return writeAgentRunResultArtifact(projectRoot, request, finalized, options.resultArtifactsDir);
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
  // This builder is an ALLOWLIST, so an unforwarded field is silently dropped. Both
  // the workflow bridge and the interactive launcher pass `modelRoleFallback` here
  // and the artifact writer reads it off the request, so omitting this line meant
  // the degradation note could never reach `locus.agent.run-result.v1` from either
  // caller — the artifact test passed only because it built its request literal
  // directly and never went through this function.
  if (input.modelRoleFallback !== undefined) request.modelRoleFallback = input.modelRoleFallback;
  if (input.parentContext !== undefined) request.parentContext = input.parentContext;
  if (input.repositoryCheckScripts !== undefined) request.repositoryCheckScripts = input.repositoryCheckScripts;
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
  failureCause: AgentFailureCause,
  lifecycleEntryIds: string[],
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "blocked",
    agentName: request.agent.name,
    reason,
    failureCause,
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
  resultArtifactsDir?: string,
): AgentRunResult {
  if (result.resultArtifact !== undefined) return result;
  const store =
    resultArtifactsDir === undefined
      ? createRuntimeArtifactStore(projectRoot)
      : new FileRuntimeArtifactStore({ rootDir: resultArtifactsDir });
  const body = {
    version: "locus.agent.run-result.v1",
    status: result.status,
    reason: result.reason,
    // The machine-readable half of `reason`. Without it the only durable record of WHY a
    // child failed is English prose, which is exactly the matching W1 exists to remove —
    // and a consumer reading envelopes back (an operator, a report, a later run) would have
    // to re-derive the classification the host already made. Undefined on success, and on
    // envelopes written before the field existed; a reader treats absence as unclassified.
    failureCause: result.failureCause,
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
    // What was asked for versus what ran, side by side and never conflated. The
    // executed value comes from the host readback carried on the result; the
    // fallback note comes from the request, because the caller knew it first.
    executedModel: result.executedModel,
    // The note is written before the child exists and says "the child inherited the
    // parent session model" — a PAST-TENSE claim about a child. It is only true once a
    // child actually RAN, so a call that died in `createSession` (unavailable
    // substrate, bad model, abort) — or that built a session and was cancelled before
    // the child was ever prompted — must not carry it: that would be fabricated
    // execution evidence in the one artifact meant to prove execution. `executedModel`
    // is published only after child kickoff, which makes it the honest gate; a created
    // -but-never-prompted session has an id and must not qualify. Undefined keys are
    // dropped by `JSON.stringify`, so this omits the field rather than writing a null.
    modelRoleFallback: result.executedModel === undefined ? undefined : request.modelRoleFallback,
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
