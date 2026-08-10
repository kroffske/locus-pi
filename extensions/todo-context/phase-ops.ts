/**
 * extensions/todo-context/phase-ops.ts — the OMP-compatible operation engine over
 * todo phases: applying an ordered op batch, resolving phases/tasks by exact
 * value, normalizing which task is active, and reporting completion transitions.
 *
 * Pure phase data in, pure phase data out: no Pi handle, no ExtensionContext, no
 * storage — persistence lives in `phase-store.ts`. The fuzzy operator matching
 * deliberately stays with the `/todo` command path in `state-commands.ts`,
 * because the tool path addresses tasks by exact content.
 */
import { cloneTodoPhases, type TodoPhase, type TodoStatus, type TodoTask } from "../_shared/project/todo-state.js";

export interface TodoOp {
  op: string;
  phase?: string;
  task?: string;
  items?: string[];
  text?: string;
  list?: Array<{ phase: string; items: string[] }>;
}

export interface TodoCompletionTransition {
  phase: string;
  content: string;
}

/**
 * Apply a batch of `todo_write` operations in order.
 *
 * Errors are accumulated without rolling back earlier successful operations.
 * This mirrors the compatibility contract tested for OMP-style behavior.
 */
export function applyTodoOps(currentPhases: TodoPhase[], ops: TodoOp[]): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = [];
  let phases = cloneTodoPhases(currentPhases);
  for (const op of ops) {
    if (op.op === "init") {
      if (!op.list) {
        errors.push("Missing list for init operation");
        continue;
      }
      phases = op.list.map((phase) => ({
        name: phase.phase,
        tasks: phase.items.map((content) => ({
          content,
          status: "pending" as const,
        })),
      }));
    }
    if (op.op === "append" && op.phase) {
      appendItems(phases, op, errors);
    }
    if (op.op === "append" && !op.phase) {
      errors.push("Missing phase name for append operation");
    }
    if (op.op === "start") {
      const hit = resolveTaskOrError(phases, op.task, errors);
      if (hit) {
        for (const phase of phases) {
          for (const task of phase.tasks) {
            if (task.status === "in_progress" && task !== hit.task) task.status = "pending";
          }
        }
        hit.task.status = "in_progress";
      }
    }
    if (op.op === "done") setTargets(phases, op, "completed", errors);
    if (op.op === "drop") setTargets(phases, op, "abandoned", errors);
    if (op.op === "rm") removeTargets(phases, op, errors);
    if (op.op === "note") addNote(phases, op, errors);
  }
  normalizeInProgressTask(phases);
  return { phases, errors };
}

function getPhase(phases: TodoPhase[], name: string): TodoPhase {
  let phase = phases.find((item) => item.name === name);
  if (!phase) {
    phase = { name, tasks: [] };
    phases.push(phase);
  }
  return phase;
}

export function findTask(phases: TodoPhase[], content: string): { task: TodoTask; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((item) => item.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function resolveTaskOrError(
  phases: TodoPhase[],
  content: string | undefined,
  errors: string[],
): { task: TodoTask; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push("Missing task content");
    return undefined;
  }
  const hit = findTask(phases, content);
  if (!hit) {
    if (/^task-\d+$/u.test(content)) {
      errors.push(
        `Task "${content}" not found. Tasks are referenced by content, not by IDs - pass the task's full text from the previous result.`,
      );
      return undefined;
    }
    const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const hint = totalTasks === 0 ? " (todo list is empty - was it replaced or not yet created?)" : "";
    errors.push(`Task "${content}" not found${hint}`);
  }
  return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
  if (!name) {
    errors.push("Missing phase name");
    return undefined;
  }
  const phase = phases.find((item) => item.name === name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

function appendItems(phases: TodoPhase[], op: TodoOp, errors: string[]): void {
  if (!op.items || op.items.length === 0) {
    errors.push("Missing items for append operation");
    return;
  }
  const phase = getPhase(phases, op.phase ?? "");
  for (const content of op.items) {
    if (findTask(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      return;
    }
    phase.tasks.push({ content, status: "pending" });
  }
}

function getTargets(phases: TodoPhase[], op: TodoOp, errors: string[]): TodoTask[] {
  if (op.task) {
    const hit = resolveTaskOrError(phases, op.task, errors);
    return hit ? [hit.task] : [];
  }
  if (op.phase) {
    const phase = resolvePhaseOrError(phases, op.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

function setTargets(phases: TodoPhase[], op: TodoOp, status: "completed" | "abandoned", errors: string[]): void {
  for (const task of getTargets(phases, op, errors)) task.status = status;
}

function removeTargets(phases: TodoPhase[], op: TodoOp, errors: string[]): void {
  if (op.task) {
    const hit = resolveTaskOrError(phases, op.task, errors);
    if (!hit) return;
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
    return;
  }
  if (op.phase) {
    const phase = resolvePhaseOrError(phases, op.phase, errors);
    if (phase) phase.tasks = [];
    return;
  }
  for (const phase of phases) phase.tasks = [];
}

function addNote(phases: TodoPhase[], op: TodoOp, errors: string[]): void {
  const hit = resolveTaskOrError(phases, op.task, errors);
  if (!hit) return;
  const text = (op.text ?? "").replace(/\s+$/u, "");
  if (!text) {
    errors.push("Missing text for note operation");
    return;
  }
  hit.task.notes = hit.task.notes ? [...hit.task.notes, text] : [text];
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
  for (const task of inProgressTasks.slice(1)) task.status = "pending";
  if (inProgressTasks.length > 0) return;
  const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
  if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/**
 * Return the task that should be shown as the current active item.
 */
export function findActiveTask(phases: readonly TodoPhase[]): string | undefined {
  return phases.flatMap((phase) => phase.tasks).find((task) => task.status === "in_progress")?.content;
}

export function findActiveTaskDetails(phases: readonly TodoPhase[]): { phase: string; task: TodoTask } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.status === "in_progress");
    if (task !== undefined) return { phase: phase.name, task };
  }
  return undefined;
}

/**
 * Report tasks that newly reached `completed` during one operation batch.
 */
export function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
  const previousStatuses = new Map<string, TodoStatus>();
  for (const phase of previous) {
    for (const task of phase.tasks) previousStatuses.set(`${phase.name}\0${task.content}`, task.status);
  }
  const transitions: TodoCompletionTransition[] = [];
  for (const phase of updated) {
    for (const task of phase.tasks) {
      const previousStatus = previousStatuses.get(`${phase.name}\0${task.content}`);
      if (task.status === "completed" && previousStatus && previousStatus !== "completed") {
        transitions.push({ phase: phase.name, content: task.content });
      }
    }
  }
  return transitions;
}
