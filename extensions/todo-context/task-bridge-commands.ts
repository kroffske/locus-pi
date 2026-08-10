/**
 * extensions/todo-context/task-bridge-commands.ts — the three explicit project
 * task verbs: `/todo from-task`, `/todo current-task`, and
 * `/todo completion-note`.
 *
 * Every one of them addresses a task by exact id from `.tasks/index.json`; no
 * current task is ever inferred, and only `completion-note` writes anything,
 * through the shared task bridge. The session-state verbs are in
 * `state-commands.ts`; the card wording is in `operator-ui.ts`.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { getProjectRoot } from "../_shared/host/pi-api.js";
import { projectDisplayPath } from "../_shared/project/prompt-command-store.js";
import {
  exportTodosToProjectTask,
  importTodosFromProjectTasks,
  loadTaskBridgeSnapshot,
  resolveCurrentProjectTask,
  writeCompletionNoteWithApproval,
  type TaskBridgeSnapshot,
} from "../_shared/project/task-bridge.js";
import { tasksRoot, type ProjectTaskWorkspace } from "../_shared/project/tasks-store.js";
import { errorMessage } from "../_shared/host/error-text.js";
import { parseCompletionNoteInput } from "./command-parser.js";
import { setTodoBlock } from "./operator-surface.js";
import {
  projectTaskResolutionBlock,
  todoChangeBlock,
  todoCompletionNoteBlock,
  todoResultBlock,
  todoWarningBlock,
} from "./operator-ui.js";
import { commitTodoPhases, loadTodoPhases } from "./phase-store.js";

type TaskBridgeTask = TaskBridgeSnapshot["tasks"][number];

interface ExplicitTaskTarget {
  task: TaskBridgeTask;
  workspace: ProjectTaskWorkspace;
}

/**
 * Seed session todo state from a single explicit project task.
 */
export async function seedTodoFromTask(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const taskId = rest.trim();
  if (taskId === "") {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Task import requires an exact task id.",
        ["Reads .tasks/index.json and seeds session todos only.", "No current task is inferred."],
        ["Usage: /todo from-task <task-id>"],
      ),
    );
    return;
  }

  try {
    const { task, workspace } = resolveExplicitTaskTarget(getProjectRoot(ctx), taskId);
    const phases = importTodosFromProjectTasks([task]);
    const commit = await commitTodoPhases(pi, ctx, phases);
    setTodoBlock(
      ctx,
      todoChangeBlock(`Seeded session todos from task ${task.id}: ${task.title}`, phases, commit.backend, [
        `taskPath: ${projectDisplayPath(getProjectRoot(ctx), workspace.taskPath)}`,
        "taskSelection: explicit",
      ]),
    );
  } catch (error) {
    renderExplicitTaskFailure(ctx, "from-task", taskId, error);
  }
}

/**
 * Render the current project task without reading or mutating session todos.
 */
export function showCurrentProjectTask(ctx: ExtensionContext): void {
  setTodoBlock(ctx, projectTaskResolutionBlock(resolveCurrentProjectTask(getProjectRoot(ctx))));
}

/**
 * Write the current session todo markdown to an explicit task artifact.
 */
export async function writeTodoCompletionNote(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const parsed = parseCompletionNoteInput(rest);
  if (parsed.usage !== undefined) {
    setTodoBlock(ctx, todoWarningBlock("Completion note requires one exact task id.", [], [parsed.usage]));
    return;
  }

  try {
    const { task, workspace } = resolveExplicitTaskTarget(getProjectRoot(ctx), parsed.taskId);
    const { phases, backend } = await loadTodoPhases(pi, ctx);
    const approval = await writeCompletionNoteWithApproval({
      pi,
      ctx,
      workspace,
      note: exportTodosToProjectTask(phases),
      approvalTier: parsed.approvalTier,
    });
    if (!approval.approved || approval.artifactPath === undefined) {
      setTodoBlock(
        ctx,
        todoResultBlock(
          `Completion note not written for task ${task.id}; session todos were not changed.`,
          ["permission: delegated-to-pi", `reason: ${approval.reason}`, `target: task:${task.id}`],
          "Todo completion note",
        ),
      );
      return;
    }

    setTodoBlock(
      ctx,
      todoCompletionNoteBlock({
        taskId: task.id,
        phases,
        backend,
        artifact: path.basename(approval.artifactPath),
        path: projectDisplayPath(getProjectRoot(ctx), approval.artifactPath),
      }),
    );
  } catch (error) {
    renderExplicitTaskFailure(ctx, "completion-note", parsed.taskId, error);
  }
}

function resolveExplicitTaskTarget(projectRoot: string, taskId: string): ExplicitTaskTarget {
  let snapshot: TaskBridgeSnapshot;
  try {
    snapshot = loadTaskBridgeSnapshot(projectRoot);
  } catch {
    throw new Error(`Task target ${taskId} cannot be resolved because .tasks/index.json is missing or unsupported.`);
  }

  const matches = snapshot.tasks.filter((candidate) => candidate.id === taskId);
  if (matches.length === 0) {
    throw new Error(`Task target ${taskId} was not found in .tasks/index.json.`);
  }
  if (matches.length > 1) {
    throw new Error(`Task target ${taskId} is ambiguous in .tasks/index.json.`);
  }
  const task = matches[0]!;
  return { task, workspace: resolveTaskWorkspace(projectRoot, task) };
}

function resolveTaskWorkspace(projectRoot: string, task: TaskBridgeTask): ProjectTaskWorkspace {
  const taskRoot = tasksRoot(projectRoot);
  const taskDir = path.resolve(taskRoot, task.path);
  if (taskDir === taskRoot || !taskDir.startsWith(`${taskRoot}${path.sep}`)) {
    throw new Error(`Task target ${task.id} resolves outside .tasks and cannot receive completion-note artifacts.`);
  }
  return {
    id: task.id,
    dir: taskDir,
    taskPath: path.join(taskDir, "task.md"),
    eventsPath: path.join(taskDir, "events.jsonl"),
  };
}

function renderExplicitTaskFailure(ctx: ExtensionContext, action: string, taskId: string, error: unknown): void {
  const message = errorMessage(error);
  setTodoBlock(
    ctx,
    todoWarningBlock(
      `/todo ${action} failed.`,
      [`target: task:${taskId}`, `error: ${message}`, "No session todos were changed."],
      [action === "from-task" ? "Retry: /todo from-task <task-id>" : "Retry: /todo completion-note [--yes] <task-id>"],
    ),
  );
}
