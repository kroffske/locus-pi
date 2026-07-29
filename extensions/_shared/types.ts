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
