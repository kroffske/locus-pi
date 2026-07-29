export interface PermissionManifest {
  id: string;
  name: string;
  version: string;
  tier: "core-owned" | "audited-fork" | "local-experimental" | "blocked";
  provides: { tools: string[]; commands: string[]; hooks: string[] };
  permissions: {
    filesystem: { read: string[]; write: string[] };
    subprocess: string[];
    network: string[];
    browser: boolean;
    models: boolean;
    ui: string[];
  };
  risk: "low" | "medium" | "high" | "critical";
  review: {
    status: "draft" | "in-review" | "reviewed" | "blocked";
    source: "write-from-scratch" | "rewrite-first" | "fork-after-audit" | "wrapper-first" | "copy-after-audit";
    reviewedBy: string | null;
    reviewedAt: string | null;
  };
}

export type AuditDecision = "allow" | "block" | "ask";

export interface AuditEvent {
  timestamp: string;
  extensionId: string;
  actionType: string;
  toolOrCommand: string;
  target: string;
  decision: AuditDecision;
  userDecision?: string;
  enforcement?: string;
  args?: string;
}

export const OUTPUT_DEFAULTS = {
  maxBytes: 64 * 1024,
  maxLines: 2000,
  astMatches: 500,
  astMaxBytes: 50 * 1024,
  browserSnapshotBytes: 100 * 1024,
  subagentSummaryBytes: 16 * 1024,
} as const;

export interface PlanTask {
  index: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "blocked";
}
export interface ExtractedPlan {
  tasks: PlanTask[];
  raw: string;
}

export type AgentSource = "bundled" | "project" | "user" | "workflow";
export type PermissionMode = "inherit-parent" | "agent-defined" | "restricted";
export type WorkspaceMode = "project" | "worktree" | "temporary-worktree";

/**
 * Machine-readable origin of a child run that did not complete.
 *
 * `status` is a four-way split, not a cause: SDK-unavailable arrives as `blocked`,
 * operator cancellation as `cancelled`, and a turn timeout, a tool-call budget breach,
 * a provider error and any mid-turn throw all collapse into one `failed` plus an English
 * sentence. A caller that wants to tell those apart today has to match on that sentence —
 * the prose-scanning move `extensions/workflows/references/patterns.md` forbids, and one
 * that starts misbehaving the day someone rewords a message.
 *
 * So the cause is declared where it is KNOWN and carried, never re-derived downstream.
 * The list is closed on purpose: `unclassified` is the honest answer for a catch-all that
 * has not been separately shown to be transient, and for any result written before this
 * field existed. Nothing retries on `unclassified`.
 *
 * It lives in this zero-import module rather than beside the agent envelope that first
 * carries it, because three modules need the closed list as a VALUE and one of them —
 * `workflow-runtime.ts`, the host-agnostic workflow core — may not import a module that
 * reaches for `node:fs` or `node:child_process`. `agent-runner.ts` re-exports it, so the
 * envelope still reads as its owner.
 */
export const AGENT_FAILURE_CAUSES = [
  /** The host's own turn budget expired and the child was aborted mid-answer. TRANSPORT. */
  "host-turn-timeout",
  /** The per-call wall-clock fuse expired and the child was aborted. TRANSPORT. */
  "call-timeout",
  /** The agent SDK substrate is unavailable — there is no channel to re-ask on. */
  "sdk-unavailable",
  /** Operator or run-level cancellation. Re-asking would override the operator. */
  "cancelled",
  /** The child exhausted its tool-call budget. A fuse that re-arms is not a fuse. */
  "tool-call-budget",
  /** The provider ended the child's assistant turn with an error. */
  "provider-error",
  /** The child answered and the boundary could not parse its final text. */
  "unparseable-answer",
  /** The run request was refused before any child existed (policy, no executor). */
  "run-policy-blocked",
  /** The requested catalog agent does not exist. An author error, not a transport one. */
  "unknown-agent",
  /** A workspace or worktree could not be allocated or resolved. */
  "workspace-allocation",
  /** The child completed with empty final text — a decomposition signal, not a dropped channel. */
  "empty-answer",
  /** The child answered past the call's declared `maxAnswerChars` bound. */
  "answer-too-long",
  /** A replayed answer the CURRENT workflow script validator rejects. */
  "script-rejected",
  /** Cause not separately identified. NEVER retried; promoting a cause out of here is
   *  its own evidenced change, not a widening of the default. */
  "unclassified",
] as const;

export type AgentFailureCause = (typeof AGENT_FAILURE_CAUSES)[number];
export type AgentEvidenceMode = "none" | "warn" | "require";
export type AgentClaimsWithoutEvidence = "off" | "warn";
export type CompletionEvidence =
  "reasoning_only" | "evidence_backed" | "missing_expected_evidence" | "claims_without_evidence";
export interface AgentEvidencePolicy {
  mode: AgentEvidenceMode;
  requireAnyToolCall?: boolean;
  requireAnyOf?: string[];
  claimsWithoutEvidence?: AgentClaimsWithoutEvidence;
}

export interface EvidenceEvaluation {
  evidence: CompletionEvidence;
  warnings: string[];
  missingRequiredTools: string[];
  observedTools: string[];
}

export interface EvidenceEvaluationInput {
  agentName: string;
  policy: AgentEvidencePolicy;
  toolCallCount: number;
  toolResultCount: number;
  observedToolNames: string[];
  outputText: string;
  status: "blocked" | "running" | "completed" | "failed" | "cancelled";
}

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools: string[];
  tools?: string[];
  spawns?: string[] | "*";
  modelOverride?: string;
  model?: string[];
  thinkingLevel?: string;
  output?: unknown;
  evidence?: AgentEvidencePolicy;
  blocking?: boolean;
  parentContextDefault?: boolean;
  risk: "low" | "medium" | "high";
  readOnly: boolean;
  permissionMode?: PermissionMode;
  source?: AgentSource;
  filePath?: string;
}

export type CatalogKind = "skill" | "prompt" | "extension" | "mcp";
export interface CatalogEntry {
  kind: CatalogKind;
  id: string;
  manifest: CatalogManifest;
  sourcePath: string;
  hash: string;
}
export interface CatalogManifest {
  name: string;
  version: string;
  description: string;
  permissions: PermissionManifest["permissions"];
  risk: "low" | "medium" | "high" | "critical";
  reviewedBy: string | null;
  reviewedAt: string | null;
  enabled: boolean;
}
