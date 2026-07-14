import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "./pi-api.js";

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface GoalPayload {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
  activeSince?: string;
}

export interface GoalState {
  version: 1;
  goal: GoalPayload;
}

export interface GoalCompletionAudit {
  version: 1;
  goalId: string;
  objective: string;
  completedAt: string;
  status: GoalStatus;
  tokensUsed: number;
  timeUsedSeconds: number;
  guidance: string[];
}

export interface GoalContinuationArtifact {
  version: 1;
  goalId: string;
  objective: string;
  path: string;
  prompt: string;
  autoDispatch: false;
  status: "manual";
  stopReason: string;
  createdAt: string;
  maxSteps: 1;
}

export interface GoalOperationResult {
  state: GoalState | null;
  changed: boolean;
  error?: string;
  message: string;
  completionAudit?: GoalCompletionAudit;
  continuation?: GoalContinuationArtifact;
}

const GOAL_DIR = path.join(".locus", "runtime", "goal");
const GOAL_STATE_FILE = "state.json";
const GOAL_AUDIT_FILE = "completion-audit.json";
const GOAL_CONTINUE_FILE = "continue.md";

export function goalStatePath(projectRoot: string): string {
  return path.join(projectRoot, GOAL_DIR, GOAL_STATE_FILE);
}

export function goalCompletionAuditPath(projectRoot: string): string {
  return path.join(projectRoot, GOAL_DIR, GOAL_AUDIT_FILE);
}

export function goalContinuationPath(projectRoot: string): string {
  return path.join(projectRoot, GOAL_DIR, GOAL_CONTINUE_FILE);
}

export function makeGoalStatePath(projectRoot: string): string {
  return goalStatePath(projectRoot);
}

export async function loadGoalState(projectRoot: string): Promise<GoalState | null> {
  const filePath = goalStatePath(projectRoot);
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as GoalState;
    if (isValidGoalState(parsed)) return parsed;
  } catch {}
  return null;
}

export async function writeGoalState(projectRoot: string, pi: ExtensionAPI | undefined, state: GoalState): Promise<GoalState> {
  const filePath = goalStatePath(projectRoot);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeState(state);
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  if (pi) {
    try {
      await pi.appendEntry("locus-goal-state", normalized);
    } catch {}
  }
  return normalized;
}

export async function writeGoalCompletionAudit(projectRoot: string, pi: ExtensionAPI | undefined, audit: GoalCompletionAudit): Promise<GoalCompletionAudit> {
  const filePath = goalCompletionAuditPath(projectRoot);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeGoalCompletionAudit(audit);
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  if (pi) {
    try {
      await pi.appendEntry("locus-goal-completion-audit", normalized);
    } catch {}
  }
  return normalized;
}

export async function writeGoalContinuationArtifact(projectRoot: string, pi: ExtensionAPI | undefined, artifact: GoalContinuationArtifact): Promise<GoalContinuationArtifact> {
  const filePath = goalContinuationPath(projectRoot);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeGoalContinuationArtifact(artifact);
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  if (pi) {
    try {
      await pi.appendEntry("locus-goal-continuation", normalized);
    } catch {}
  }
  return normalized;
}

export async function createOrReplaceGoalState(
  projectRoot: string,
  pi: ExtensionAPI | undefined,
  objective: string,
  tokenBudget?: number,
): Promise<GoalOperationResult> {
  const trimmed = objective.trim();
  if (trimmed.length === 0) return { state: null, changed: false, error: "Missing objective", message: "No objective provided." };
  const now = new Date();
  const nowIso = now.toISOString();

  const createdState: GoalState = {
    version: 1,
    goal: {
      id: makeGoalId(),
      objective: trimmed,
      status: "active",
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      activeSince: nowIso,
    },
  };
  const saved = await writeGoalState(projectRoot, pi, createdState);
  return { state: saved, changed: true, message: "Goal created." };
}

export async function showGoal(projectRoot: string): Promise<GoalOperationResult> {
  const state = await loadGoalState(projectRoot);
  if (!state) return { state: null, changed: false, message: "No active goal." };
  return { state, changed: false, message: renderGoalSummary(state) };
}

export async function pauseGoalState(projectRoot: string, pi: ExtensionAPI | undefined): Promise<GoalOperationResult> {
  const existing = await loadGoalState(projectRoot);
  if (!existing) return { state: null, changed: false, message: "No goal to pause." };
  if (existing.goal.status === "complete" || existing.goal.status === "dropped") {
    return { state: existing, changed: false, message: `Goal is already ${existing.goal.status}.` };
  }
  if (existing.goal.status === "paused") return { state: existing, changed: false, message: "Goal is already paused." };

  const now = new Date().toISOString();
  const { activeSince: _activeSince, ...goalWithoutActiveSince } = existing.goal;
  const next: GoalState = {
    ...existing,
    goal: {
      ...goalWithoutActiveSince,
      status: "paused",
      updatedAt: now,
      timeUsedSeconds: elapsedSeconds(existing.goal.createdAt),
    },
  };
  const saved = await writeGoalState(projectRoot, pi, next);
  return { state: saved, changed: true, message: `Goal paused: ${existing.goal.objective}` };
}

export async function resumeGoalState(projectRoot: string, pi: ExtensionAPI | undefined): Promise<GoalOperationResult> {
  const existing = await loadGoalState(projectRoot);
  if (!existing) return { state: null, changed: false, message: "No goal to resume." };
  if (existing.goal.status === "complete" || existing.goal.status === "dropped") {
    return { state: existing, changed: false, message: `Goal is ${existing.goal.status}.` };
  }
  if (existing.goal.status === "active" && !isBudgetLimited(existing, existing.goal)) {
    return { state: existing, changed: false, message: "Goal is already active." };
  }

  const now = new Date().toISOString();
  const resumeStatus: GoalStatus = decideStatusAfterResume(existing.goal);
  const next: GoalState = {
    ...existing,
    goal: {
      ...existing.goal,
      status: resumeStatus,
      activeSince: now,
      updatedAt: now,
      timeUsedSeconds: elapsedSeconds(existing.goal.createdAt),
    },
  };
  const saved = await writeGoalState(projectRoot, pi, next);
  return { state: saved, changed: true, message: `Goal resumed: ${existing.goal.objective}` };
}

export async function completeGoalState(projectRoot: string, pi: ExtensionAPI | undefined): Promise<GoalOperationResult> {
  const existing = await loadGoalState(projectRoot);
  if (!existing) return { state: null, changed: false, message: "No goal to complete." };
  if (existing.goal.status === "complete") return { state: existing, changed: false, message: "Goal is already complete." };

  const now = new Date().toISOString();
  const { activeSince: _activeSince, ...goalWithoutActiveSince } = existing.goal;
  const next: GoalState = {
    ...existing,
    goal: {
      ...goalWithoutActiveSince,
      status: "complete",
      updatedAt: now,
      timeUsedSeconds: elapsedSeconds(existing.goal.createdAt),
    },
  };
  const saved = await writeGoalState(projectRoot, pi, next);
  const audit = await writeGoalCompletionAudit(projectRoot, pi, {
    version: 1,
    goalId: saved.goal.id,
    objective: saved.goal.objective,
    completedAt: now,
    status: saved.goal.status,
    tokensUsed: saved.goal.tokensUsed,
    timeUsedSeconds: saved.goal.timeUsedSeconds,
    guidance: goalCompletionGuidance(saved.goal),
  });
  return { state: saved, changed: true, message: `Goal completed: ${existing.goal.objective}`, completionAudit: audit };
}

export async function dropGoalState(projectRoot: string, pi: ExtensionAPI | undefined): Promise<GoalOperationResult> {
  const existing = await loadGoalState(projectRoot);
  if (!existing) return { state: null, changed: false, message: "No goal to drop." };
  if (existing.goal.status === "dropped") return { state: existing, changed: false, message: "Goal is already dropped." };

  const now = new Date().toISOString();
  const { activeSince: _activeSince, ...goalWithoutActiveSince } = existing.goal;
  const next: GoalState = {
    ...existing,
    goal: {
      ...goalWithoutActiveSince,
      status: "dropped",
      updatedAt: now,
      timeUsedSeconds: elapsedSeconds(existing.goal.createdAt),
    },
  };
  const saved = await writeGoalState(projectRoot, pi, next);
  return { state: saved, changed: true, message: `Goal dropped: ${existing.goal.objective}` };
}

export async function setGoalBudget(projectRoot: string, pi: ExtensionAPI | undefined, rawBudget: string): Promise<GoalOperationResult> {
  const existing = await loadGoalState(projectRoot);
  if (!existing) return { state: null, changed: false, message: "No goal to set budget." };

  if (rawBudget.toLowerCase() === "off") {
    const now = new Date().toISOString();
    const { tokenBudget: _tokenBudget, ...goalWithoutBudget } = existing.goal;
    const status = existing.goal.status === "budget-limited" ? "active" as GoalStatus : existing.goal.status;
    const next: GoalState = {
      ...existing,
      goal: {
        ...goalWithoutBudget,
        status,
        updatedAt: now,
        timeUsedSeconds: elapsedSeconds(existing.goal.createdAt),
      },
    };
    const saved = await writeGoalState(projectRoot, pi, next);
    return { state: saved, changed: true, message: `Goal budget cleared for ${existing.goal.id}.` };
  }

  const tokenBudget = Number.parseInt(rawBudget, 10);
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return { state: existing, changed: false, error: "Invalid budget", message: "Budget must be a positive integer or off." };
  }

  const now = new Date().toISOString();
  const nextStatus: GoalStatus =
    existing.goal.status === "complete" || existing.goal.status === "dropped"
      ? existing.goal.status
      : existing.goal.status === "paused"
        ? existing.goal.tokensUsed >= tokenBudget
          ? "budget-limited"
          : "paused"
        : existing.goal.tokensUsed >= tokenBudget
          ? "budget-limited"
          : "active";

  const next: GoalState = {
    ...existing,
    goal: {
      ...existing.goal,
      tokenBudget,
      status: nextStatus,
      updatedAt: now,
      timeUsedSeconds: elapsedSeconds(existing.goal.createdAt),
    },
  };
  const saved = await writeGoalState(projectRoot, pi, next);
  return { state: saved, changed: true, message: `Goal budget set to ${tokenBudget} tokens.` };
}

export function shouldInjectGoalContext(state: GoalState | null): boolean {
  if (!state) return false;
  return state.goal.status !== "complete" && state.goal.status !== "dropped";
}

export function goalInjectionText(state: GoalState): string {
  const goal = state.goal;
  return [
    "<goal_context>",
    `id=${goal.id}`,
    `objective=${goal.objective}`,
    `status=${goal.status}`,
    `tokenBudget=${goal.tokenBudget ?? "off"}`,
    `tokensUsed=${goal.tokensUsed}`,
    `timeUsedSeconds=${goal.timeUsedSeconds.toFixed(0)}`,
    `createdAt=${goal.createdAt}`,
    `updatedAt=${goal.updatedAt}`,
    ...(goal.activeSince ? [`activeSince=${goal.activeSince}`] : []),
    "</goal_context>",
  ].join("\n");
}

export function goalCompletionGuidance(goal: GoalPayload): string[] {
  return [
    `Goal ${goal.id} is complete.`,
    "Record the final outcome, remaining risks, and any handoff notes explicitly.",
    "If the work should continue, use /goal continue to write a bounded next-step artifact.",
    "Do not auto-dispatch a continuation. Keep the next step manual and bounded.",
  ];
}

export function renderGoalSummary(state: GoalState): string {
  const goal = state.goal;
  return boundGoalDisplayLines([
    `id: ${goal.id}`,
    `status: ${goal.status}`,
    `objective: ${goal.objective}`,
    `tokensUsed: ${goal.tokensUsed}`,
    `timeUsedSeconds: ${goal.timeUsedSeconds}`,
    `createdAt: ${goal.createdAt}`,
    `updatedAt: ${goal.updatedAt}`,
    ...(goal.activeSince ? [`activeSince: ${goal.activeSince}`] : []),
    ...(goal.tokenBudget === undefined ? [] : [`tokenBudget: ${goal.tokenBudget}`]),
    `storage: .locus/runtime/goal/state.json`,
  ]).join("\n");
}

export function renderGoalCompletionAudit(audit: GoalCompletionAudit): string {
  return [
    `goalId: ${audit.goalId}`,
    `objective: ${audit.objective}`,
    `completedAt: ${audit.completedAt}`,
    `status: ${audit.status}`,
    `tokensUsed: ${audit.tokensUsed}`,
    `timeUsedSeconds: ${audit.timeUsedSeconds}`,
    "guidance:",
    ...audit.guidance.map((line) => `- ${line}`),
    `storage: ${goalCompletionAuditPath(process.cwd())}`,
  ].join("\n");
}

export function buildGoalContinuationArtifact(projectRoot: string, goalId: string, objective: string, raw: string): GoalContinuationArtifact {
  const trimmed = raw.trim();
  const parts = trimmed === "" ? [] : trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const summary = parts[0];
  const nextStep = parts[1] ?? "Choose one bounded next action and stop.";
  const lines = [
    "Task:",
    objective,
    "",
    "Draft goal:",
    `Continue ${goalId} with one bounded step only.`,
    "",
    "Intent:",
    summary ?? "Summarize the completion state and propose the next bounded step.",
    "",
    "Context:",
    "- Keep the next prompt short and action-oriented.",
    "- Do not auto-dispatch a child agent or model call.",
    "- Stop after one next step.",
    "",
    "Draft direction:",
    `- In scope: ${nextStep}`,
    "- Out of scope: multi-step plans, background dispatch, or hidden continuation.",
    "- Outcome type: prompt",
    "",
    "Expected result:",
    "- one bounded next prompt artifact",
    "",
    "Final result:",
    nextStep,
  ];
  return normalizeGoalContinuationArtifact({
    version: 1,
    goalId,
    objective,
    path: goalContinuationPath(projectRoot),
    prompt: lines.join("\n"),
    autoDispatch: false,
    status: "manual",
    stopReason: "continuation is a bounded next prompt artifact, not auto-dispatch",
    createdAt: new Date().toISOString(),
    maxSteps: 1,
  });
}

export function renderGoalContinuationArtifact(artifact: GoalContinuationArtifact): string {
  return boundGoalDisplayLines([
    `goalId: ${artifact.goalId}`,
    `objective: ${artifact.objective}`,
    `path: ${artifact.path}`,
    `autoDispatch: ${artifact.autoDispatch}`,
    `status: ${artifact.status}`,
    `stopReason: ${artifact.stopReason}`,
    `createdAt: ${artifact.createdAt}`,
    `maxSteps: ${artifact.maxSteps}`,
  ]).join("\n");
}

function boundGoalDisplayLines(lines: string[]): string[] {
  return lines.map((line) => {
    if (line.length <= 80) return line;
    return `${line.slice(0, 77)}...`;
  });
}

export function decideStatusAfterResume(current: GoalPayload): GoalStatus {
  if (current.status === "complete" || current.status === "dropped") return current.status;
  if (current.status === "budget-limited") return "budget-limited";
  if (current.status === "paused") return chooseActiveOrBudgetLimited(current);
  return "active";
}

export function isBudgetLimited(state: GoalState, current: GoalPayload = state.goal): boolean {
  return current.status === "budget-limited" || (current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget);
}

function chooseActiveOrBudgetLimited(current: GoalPayload): GoalStatus {
  return current.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget ? "budget-limited" : "active";
}

function makeGoalId(): string {
  const suffix = Math.random().toString(16).slice(2, 10);
  return `goal-${Date.now()}-${suffix}`;
}

function isValidGoalState(candidate: GoalState): candidate is GoalState {
  if (candidate.version !== 1) return false;
  const goal = candidate.goal;
  return (
    typeof goal?.id === "string"
    && typeof goal.objective === "string"
    && typeof goal.status === "string"
    && ["active", "paused", "budget-limited", "complete", "dropped"].includes(goal.status)
    && typeof goal.tokensUsed === "number"
    && typeof goal.timeUsedSeconds === "number"
    && Number.isFinite(goal.tokensUsed)
    && Number.isFinite(goal.timeUsedSeconds)
    && typeof goal.createdAt === "string"
    && typeof goal.updatedAt === "string"
  );
}

function normalizeGoalCompletionAudit(audit: GoalCompletionAudit): GoalCompletionAudit {
  return {
    ...audit,
    version: 1,
    guidance: [...audit.guidance],
  };
}

function normalizeGoalContinuationArtifact(artifact: GoalContinuationArtifact): GoalContinuationArtifact {
  return {
    ...artifact,
    version: 1,
    status: "manual",
    stopReason: artifact.stopReason.trim() || "continuation is a bounded next prompt artifact, not auto-dispatch",
    createdAt: artifact.createdAt.trim() || new Date().toISOString(),
    maxSteps: 1,
  };
}

function elapsedSeconds(createdAt: string): number {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 1000));
}

function normalizeState(state: GoalState): GoalState {
  const safeTokenBudget = state.goal.tokenBudget === undefined ? undefined : Math.max(1, state.goal.tokenBudget);
  const normalizedStatus = ensureStatus(state.goal);
  return {
    version: 1,
    goal: {
      ...state.goal,
      ...(safeTokenBudget === undefined ? {} : { tokenBudget: safeTokenBudget }),
      status: normalizedStatus,
    },
  };
}

function ensureStatus(goal: GoalPayload): GoalStatus {
  if (goal.status === "budget-limited") return isBudgetLimited({ version: 1, goal }, goal) ? "budget-limited" : chooseActiveOrBudgetLimited(goal);
  return goal.status;
}
