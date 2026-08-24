import type { ExtensionAPI, ExtensionContext } from "../host/pi-api.js";
import type { RuntimeArtifact } from "../runtime/artifacts.js";
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

export const CURRENT_PROJECT_TASK_STATUS_ORDER = [
  "doing",
  "review",
  "planning",
  "planned",
] as const satisfies readonly ProjectTaskStatus[];
export type CurrentProjectTaskStatus = (typeof CURRENT_PROJECT_TASK_STATUS_ORDER)[number];

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
    return unresolvedCurrentTask(
      "missing-index",
      [],
      "Cannot resolve current project task because .tasks/index.json is missing or unsupported.",
    );
  }

  const candidates = snapshot.tasks
    .filter((task): task is ProjectTaskIndexEntry & { status: CurrentProjectTaskStatus } =>
      isCurrentProjectTaskStatus(task.status),
    )
    .map(currentTaskCandidate);
  if (candidates.length === 0) {
    return unresolvedCurrentTask("no-current-task", [], "No current project task is available in .tasks/index.json.");
  }

  for (const status of CURRENT_PROJECT_TASK_STATUS_ORDER) {
    const statusCandidates = candidates.filter((candidate) => candidate.currentStatus === status);
    if (statusCandidates.length === 0) continue;
    if (statusCandidates.length > 1) {
      return unresolvedCurrentTask(
        "multiple-current-tasks",
        statusCandidates,
        `Multiple ${status} project tasks exist in .tasks/index.json.`,
      );
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

export function createTaskFromApprovedPrompt(input: CreateTaskFromPromptInput): ProjectTaskWorkspace {
  if (input.artifact.kind !== "prepared-task-draft")
    throw new Error("Task bridge requires a prepared-task-draft artifact.");
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
// (see tests/shared/project/task-bridge.test.ts `legacyDenyTier`). Do not re-introduce an extension-level
// gate here without also updating todo-context's advertised behavior and that test.
export async function writeCompletionNoteWithApproval(
  input: CompletionNoteInput,
): Promise<{ approved: boolean; artifactPath?: string; reason: string }> {
  const artifactPath = writeTaskArtifact(input.workspace.dir, "completion-note.md", input.note);
  return { approved: true, artifactPath, reason: "Pi approval owns filesystem write decisions." };
}

export function exportTodosToProjectTask(phases: TodoPhase[]): string {
  return cloneTodoPhases(phases)
    .flatMap((phase) => [
      `## ${phase.name}`,
      "",
      ...phase.tasks.map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.content}`),
      "",
    ])
    .join("\n");
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

function isCurrentProjectTaskStatus(status: ProjectTaskStatus): status is CurrentProjectTaskStatus {
  return (CURRENT_PROJECT_TASK_STATUS_ORDER as readonly ProjectTaskStatus[]).includes(status);
}

function currentTaskCandidate(
  task: ProjectTaskIndexEntry & { status: CurrentProjectTaskStatus },
): CurrentProjectTaskCandidate {
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
