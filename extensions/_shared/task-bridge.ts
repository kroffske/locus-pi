import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "./pi-api.js";
import type { RuntimeArtifact } from "./artifacts.js";
import type { TodoPhase } from "./todo-state.js";
import { cloneTodoPhases } from "./todo-state.js";
import {
  createProjectTaskWorkspace,
  flattenProjectTasks,
  readProjectTaskIndex,
  tasksRoot,
  writeTaskArtifact,
  type ProjectTaskIndexEntry,
  type ProjectTaskStatus,
  type ProjectTaskWorkspace,
} from "./tasks-store.js";

export const TASK_LIFECYCLE_TARGET_STATUSES = ["planned", "planning", "doing", "review", "blocked", "wontdo", "done"] as const;
export type TaskLifecycleTargetStatus = typeof TASK_LIFECYCLE_TARGET_STATUSES[number];

export const CURRENT_PROJECT_TASK_STATUS_ORDER = ["doing", "review", "planning", "planned"] as const satisfies readonly ProjectTaskStatus[];
export type CurrentProjectTaskStatus = typeof CURRENT_PROJECT_TASK_STATUS_ORDER[number];

const TASK_LIFECYCLE_TRANSITIONS: Record<ProjectTaskStatus, readonly TaskLifecycleTargetStatus[]> = {
  draft: ["planned", "planning", "blocked", "wontdo"],
  planned: ["planning", "doing", "blocked", "wontdo"],
  planning: ["doing", "blocked", "wontdo"],
  doing: ["review", "blocked", "wontdo"],
  review: ["done", "doing", "blocked", "wontdo"],
  blocked: ["doing", "wontdo"],
  done: [],
  wontdo: [],
};

export interface TaskBridgeSnapshot {
  tasks: ProjectTaskIndexEntry[];
}

export interface CurrentProjectTaskCandidate {
  taskId: string;
  taskTitle: string;
  taskPath: string;
  currentStatus: CurrentProjectTaskStatus;
  taskKind: "task" | "subtask";
  parentId?: string;
}

export interface CurrentProjectTaskResolved {
  ok: true;
  taskId: string;
  taskTitle: string;
  taskPath: string;
  currentStatus: CurrentProjectTaskStatus;
  taskKind: "task" | "subtask";
  parentId?: string;
  selectionRule: string;
  message: string;
}

export interface CurrentProjectTaskUnresolved {
  ok: false;
  code: "missing-index" | "no-current-task" | "multiple-current-tasks";
  candidates: CurrentProjectTaskCandidate[];
  selectionRule: string;
  message: string;
}

export type CurrentProjectTaskResolution = CurrentProjectTaskResolved | CurrentProjectTaskUnresolved;

export interface TaskLifecycleSuccessPlan {
  ok: true;
  dryRun: true;
  taskId: string;
  taskTitle: string;
  taskPath: string;
  currentStatus: ProjectTaskStatus;
  targetStatus: TaskLifecycleTargetStatus;
  message: string;
}

export interface TaskLifecycleMissingTaskPlan {
  ok: false;
  dryRun: true;
  code: "missing-task";
  taskId: string;
  targetStatus: TaskLifecycleTargetStatus;
  message: string;
}

export interface TaskLifecycleUnsupportedTransitionPlan {
  ok: false;
  dryRun: true;
  code: "unsupported-transition";
  taskId: string;
  taskTitle: string;
  taskPath: string;
  currentStatus: ProjectTaskStatus;
  targetStatus: TaskLifecycleTargetStatus;
  allowedTargets: TaskLifecycleTargetStatus[];
  message: string;
}

export interface TaskLifecycleDonePreconditionFailedPlan {
  ok: false;
  dryRun: true;
  code: "done-precondition-failed";
  taskId: string;
  taskTitle: string;
  taskPath: string;
  currentStatus: ProjectTaskStatus;
  targetStatus: "done";
  missingPreconditions: string[];
  message: string;
}

export type TaskLifecyclePlan =
  | TaskLifecycleSuccessPlan
  | TaskLifecycleMissingTaskPlan
  | TaskLifecycleUnsupportedTransitionPlan
  | TaskLifecycleDonePreconditionFailedPlan;

export interface CreateTaskFromPromptInput {
  projectRoot: string;
  artifact: RuntimeArtifact;
  taskId: string;
  title: string;
  now?: string;
}

export interface CompletionNoteInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  workspace: ProjectTaskWorkspace;
  note: string;
  approvalTier?: "allow" | "prompt" | "deny";
  now?: string;
}

export function loadTaskBridgeSnapshot(projectRoot: string): TaskBridgeSnapshot {
  return {
    tasks: flattenProjectTasks(readProjectTaskIndex(tasksRoot(projectRoot))),
  };
}

export function resolveCurrentProjectTask(projectRoot: string): CurrentProjectTaskResolution {
  let snapshot: TaskBridgeSnapshot;
  try {
    snapshot = loadTaskBridgeSnapshot(projectRoot);
  } catch {
    return unresolvedCurrentTask("missing-index", [], "Cannot resolve current project task because .tasks/index.json is missing or unsupported.");
  }

  const candidates = snapshot.tasks
    .filter((task): task is ProjectTaskIndexEntry & { status: CurrentProjectTaskStatus } => isCurrentProjectTaskStatus(task.status))
    .map(currentTaskCandidate);
  if (candidates.length === 0) {
    return unresolvedCurrentTask("no-current-task", [], "No current project task is available in .tasks/index.json.");
  }

  for (const status of CURRENT_PROJECT_TASK_STATUS_ORDER) {
    const statusCandidates = candidates.filter((candidate) => candidate.currentStatus === status);
    if (statusCandidates.length === 0) continue;
    if (statusCandidates.length > 1) {
      return unresolvedCurrentTask("multiple-current-tasks", statusCandidates, `Multiple ${status} project tasks exist in .tasks/index.json.`);
    }
    const task = statusCandidates[0]!;
    return {
      ok: true,
      ...task,
      selectionRule: currentTaskSelectionRule(),
      message: "Resolved from .tasks/index.json only.",
    };
  }

  return unresolvedCurrentTask("no-current-task", [], "No current project task is available in .tasks/index.json.");
}

export function formatCurrentProjectTaskResolution(resolution: CurrentProjectTaskResolution): string {
  const lines = ["Current project task", `ok: ${resolution.ok}`, `selectionRule: ${resolution.selectionRule}`];
  if (resolution.ok) {
    lines.push(
      `taskId: ${resolution.taskId}`,
      `taskTitle: ${resolution.taskTitle}`,
      `taskPath: ${resolution.taskPath}`,
      `currentStatus: ${resolution.currentStatus}`,
      `taskKind: ${resolution.taskKind}`,
    );
    if (resolution.parentId !== undefined) lines.push(`parentId: ${resolution.parentId}`);
    lines.push(`message: ${resolution.message}`);
    return lines.join("\n");
  }

  lines.push(`code: ${resolution.code}`);
  if (resolution.candidates.length > 0) {
    lines.push("candidates:", ...resolution.candidates.map(formatCurrentTaskCandidate));
  }
  lines.push(`message: ${resolution.message}`);
  return lines.join("\n");
}

export function planTaskLifecycleTransition(projectRoot: string, taskId: string, targetStatus: TaskLifecycleTargetStatus): TaskLifecyclePlan {
  let snapshot: TaskBridgeSnapshot;
  try {
    snapshot = loadTaskBridgeSnapshot(projectRoot);
  } catch {
    return {
      ok: false,
      dryRun: true,
      code: "missing-task",
      taskId,
      targetStatus,
      message: `Task ${taskId} was not found in .tasks/index.json.`,
    };
  }

  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return {
      ok: false,
      dryRun: true,
      code: "missing-task",
      taskId,
      targetStatus,
      message: `Task ${taskId} was not found in .tasks/index.json.`,
    };
  }

  const allowedTargets = TASK_LIFECYCLE_TRANSITIONS[task.status] ?? [];
  if (!allowedTargets.includes(targetStatus)) {
    return {
      ok: false,
      dryRun: true,
      code: "unsupported-transition",
      taskId: task.id,
      taskTitle: task.title,
      taskPath: task.path,
      currentStatus: task.status,
      targetStatus,
      allowedTargets: [...allowedTargets],
      message: `Transition from ${task.status} to ${targetStatus} is unsupported.`,
    };
  }

  if (targetStatus === "done") {
    const missingPreconditions = collectDonePreconditionFailures(projectRoot, task);
    if (missingPreconditions.length > 0) {
      return {
        ok: false,
        dryRun: true,
        code: "done-precondition-failed",
        taskId: task.id,
        taskTitle: task.title,
        taskPath: task.path,
        currentStatus: task.status,
        targetStatus,
        missingPreconditions,
        message: "Transition to done is blocked until all preconditions pass.",
      };
    }
  }

  return {
    ok: true,
    dryRun: true,
    taskId: task.id,
    taskTitle: task.title,
    taskPath: task.path,
    currentStatus: task.status,
    targetStatus,
    message: "Dry-run only. `locus task update` remains the mutation path.",
  };
}

export function formatTaskLifecyclePlan(plan: TaskLifecyclePlan): string {
  const lines = ["Task lifecycle dry-run", `ok: ${plan.ok}`, `dryRun: true`];
  if (plan.ok) {
    lines.push(
      `taskId: ${plan.taskId}`,
      `taskTitle: ${plan.taskTitle}`,
      `taskPath: ${plan.taskPath}`,
      `currentStatus: ${plan.currentStatus}`,
      `targetStatus: ${plan.targetStatus}`,
      `message: ${plan.message}`,
    );
    return lines.join("\n");
  }

  lines.push(`code: ${plan.code}`, `taskId: ${plan.taskId}`, `targetStatus: ${plan.targetStatus}`);
  if (plan.code !== "missing-task") {
    lines.push(
      `taskTitle: ${plan.taskTitle}`,
      `taskPath: ${plan.taskPath}`,
      `currentStatus: ${plan.currentStatus}`,
    );
  }
  if (plan.code === "unsupported-transition") {
    lines.push(`allowedTargets: ${formatAllowedTargets(plan.allowedTargets)}`);
  }
  if (plan.code === "done-precondition-failed") {
    lines.push("missingPreconditions:", ...plan.missingPreconditions.map((precondition) => `- ${precondition}`));
  }
  lines.push(`message: ${plan.message}`);
  return lines.join("\n");
}

export function createTaskFromApprovedPrompt(input: CreateTaskFromPromptInput): ProjectTaskWorkspace {
  if (input.artifact.kind !== "prepared-task-draft") throw new Error("Task bridge requires a prepared-task-draft artifact.");
  if (input.artifact.metadata.status !== "approved" && input.artifact.metadata.status !== "handed_off") {
    throw new Error("Task bridge requires an approved prompt artifact.");
  }
  const createInput = {
    id: input.taskId,
    title: input.title,
    outcome: "Execute the approved prepared-task prompt.",
    sourceArtifactPath: input.artifact.path,
  };
  const withOptional: Parameters<typeof createProjectTaskWorkspace>[1] = createInput;
  if (input.artifact.sessionId !== undefined) withOptional.sourceSessionId = input.artifact.sessionId;
  if (input.now !== undefined) withOptional.now = input.now;
  return createProjectTaskWorkspace(tasksRoot(input.projectRoot), withOptional);
}

// Intentionally writes the completion-note artifact regardless of `input.approvalTier`.
// The host's filesystem-write approval layer — not this extension — gates the write
// (permission: delegated-to-pi). `approvalTier` is parsed by `/todo completion-note` for
// forward-compatibility and is advisory only; the "deny" tier is legacy and still writes
// (see tests/shared/task/tasks-bridge.test.ts `legacyDenyTier`). Do not re-introduce an extension-level
// gate here without also updating todo-context's advertised behavior and that test.
export async function writeCompletionNoteWithApproval(input: CompletionNoteInput): Promise<{ approved: boolean; artifactPath?: string; reason: string }> {
  const artifactPath = writeTaskArtifact(input.workspace.dir, "completion-note.md", input.note);
  return { approved: true, artifactPath, reason: "Pi approval owns filesystem write decisions." };
}

export function exportTodosToProjectTask(phases: TodoPhase[]): string {
  return cloneTodoPhases(phases).flatMap((phase) => [
    `## ${phase.name}`,
    "",
    ...phase.tasks.map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.content}`),
    "",
  ]).join("\n");
}

export function importTodosFromProjectTasks(tasks: ProjectTaskIndexEntry[]): TodoPhase[] {
  return [
    {
      name: "Project tasks",
      tasks: tasks.map((task) => ({
        content: `${task.id}: ${task.title}`,
        status: task.status === "done" ? "completed" : task.status === "doing" ? "in_progress" : "pending",
      })),
    },
  ];
}

function collectDonePreconditionFailures(projectRoot: string, task: ProjectTaskIndexEntry): string[] {
  const workspaceRoot = path.join(tasksRoot(projectRoot), task.path);
  const missing: string[] = [];
  const qaText = readTextIfExists(path.join(workspaceRoot, "qa.md"));
  if (qaText === undefined || !/\bACCEPTED\b/.test(qaText)) missing.push("qa.md missing ACCEPTED");
  const taskText = readTextIfExists(path.join(workspaceRoot, "task.md"));
  if (taskText === undefined || !hasNonPlaceholderClosureText(taskText)) missing.push("task.md missing non-placeholder Closure text");
  return missing;
}

function readTextIfExists(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
}

function hasNonPlaceholderClosureText(markdown: string): boolean {
  const closureSection = extractSection(markdown, "Closure");
  if (closureSection === undefined) return false;
  const lines = closureSection.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.some((line) => {
    const normalized = line.replace(/^[-*>#\d.\s]+/, "").trim().toLowerCase();
    if (normalized.length === 0) return false;
    return !isPlaceholderClosureLine(normalized);
  });
}

function extractSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (headingIndex < 0) return undefined;
  const sectionLines: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (/^##\s+\S/.test(line.trim())) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n").trim();
}

function isPlaceholderClosureLine(value: string): boolean {
  return [
    /^tbd[.!?]*$/,
    /^todo[.!?]*$/,
    /^placeholder[.!?]*$/,
    /^coming soon[.!?]*$/,
    /^to be (?:written|filled|done)[.!?]*$/,
    /^fill(?: in)?(?: later)?[.!?]*$/,
    /^pending[.!?]*$/,
    /^n\/a[.!?]*$/,
    /^none[.!?]*$/,
    /^\.\.\.[.!?]*$/,
  ].some((pattern) => pattern.test(value));
}

function formatAllowedTargets(allowedTargets: readonly TaskLifecycleTargetStatus[]): string {
  return allowedTargets.length === 0 ? "none" : allowedTargets.join(", ");
}

function isCurrentProjectTaskStatus(status: ProjectTaskStatus): status is CurrentProjectTaskStatus {
  return (CURRENT_PROJECT_TASK_STATUS_ORDER as readonly ProjectTaskStatus[]).includes(status);
}

function currentTaskCandidate(task: ProjectTaskIndexEntry & { status: CurrentProjectTaskStatus }): CurrentProjectTaskCandidate {
  const parentId = normalizedParentId(task);
  return {
    taskId: task.id,
    taskTitle: task.title,
    taskPath: task.path,
    currentStatus: task.status,
    taskKind: parentId === undefined && !task.path.split("/").includes("subtasks") ? "task" : "subtask",
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function unresolvedCurrentTask(
  code: CurrentProjectTaskUnresolved["code"],
  candidates: CurrentProjectTaskCandidate[],
  message: string,
): CurrentProjectTaskUnresolved {
  return {
    ok: false,
    code,
    candidates,
    selectionRule: currentTaskSelectionRule(),
    message,
  };
}

function currentTaskSelectionRule(): string {
  return `highest unique status in ${CURRENT_PROJECT_TASK_STATUS_ORDER.join(" > ")}`;
}

function formatCurrentTaskCandidate(candidate: CurrentProjectTaskCandidate): string {
  const base = `- ${candidate.taskId} (${candidate.currentStatus}, ${candidate.taskKind}) ${candidate.taskTitle} path=${candidate.taskPath}`;
  return candidate.parentId === undefined ? base : `${base} parentId=${candidate.parentId}`;
}

function normalizedParentId(task: ProjectTaskIndexEntry): string | undefined {
  const parentId = task.parent_id?.trim();
  return parentId === undefined || parentId === "" ? undefined : parentId;
}
