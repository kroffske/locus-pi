import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { flattenProjectTasks, readProjectTaskIndex, tasksRoot, type ProjectTaskIndexEntry } from "./tasks-store.js";

export type PromptCommandKind = "plan" | "goal" | "review" | "todos";
export type PromptCommandTargetSelector = { type: "project" } | { type: "task"; taskId: string };

interface PromptCommandTarget {
  kind: PromptCommandKind;
  target: "project-local" | `task:${string}`;
  path: string;
  displayPath: string;
}

export class PromptCommandTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCommandTargetError";
  }
}

export function resolvePromptCommandTarget(projectRoot: string, kind: PromptCommandKind, selector: PromptCommandTargetSelector = { type: "project" }): PromptCommandTarget {
  if (selector.type === "project") {
    const filePath = path.join(projectRoot, ".locus", "runtime", "prompts", `${kind}.md`);
    return { kind, target: "project-local", path: filePath, displayPath: displayPath(projectRoot, filePath) };
  }

  const taskRoot = tasksRoot(projectRoot);
  const task = findTask(projectRoot, selector.taskId);
  const taskDir = safeTaskDir(taskRoot, task.path, selector.taskId);
  const filePath = path.join(taskDir, "artifacts", `${kind}-prompt.md`);
  return { kind, target: `task:${task.id}`, path: filePath, displayPath: displayPath(projectRoot, filePath) };
}

export function readPromptCommand(target: PromptCommandTarget): string | undefined {
  if (!existsSync(target.path)) return undefined;
  return readFileSync(target.path, "utf8");
}

export function writePromptCommand(target: PromptCommandTarget, prompt: string): void {
  const content = renderPromptCommandMarkdown(target.kind, prompt);
  mkdirSync(path.dirname(target.path), { recursive: true });
  writeFileSync(target.path, content);
}

function renderPromptCommandMarkdown(kind: PromptCommandKind, prompt: string): string {
  return [`# ${kind}`, "", prompt.trim(), ""].join("\n");
}

function findTask(projectRoot: string, taskId: string): ProjectTaskIndexEntry {
  let tasks: ProjectTaskIndexEntry[];
  try {
    tasks = flattenProjectTasks(readProjectTaskIndex(tasksRoot(projectRoot)));
  } catch {
    throw new PromptCommandTargetError(`Task target ${taskId} cannot be resolved because .tasks/index.json is missing or unsupported.`);
  }
  const matches = tasks.filter((task) => task.id === taskId);
  if (matches.length === 0) throw new PromptCommandTargetError(`Task target ${taskId} was not found in .tasks/index.json.`);
  if (matches.length > 1) throw new PromptCommandTargetError(`Task target ${taskId} is ambiguous in .tasks/index.json.`);
  return matches[0]!;
}

function safeTaskDir(taskRoot: string, taskPath: string, taskId: string): string {
  const taskDir = path.resolve(taskRoot, taskPath);
  const root = path.resolve(taskRoot);
  if (taskDir !== root && taskDir.startsWith(`${root}${path.sep}`)) return taskDir;
  throw new PromptCommandTargetError(`Task target ${taskId} resolves outside .tasks and cannot receive prompt artifacts.`);
}

function displayPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath).split(path.sep).join("/");
  return relative.startsWith("..") ? filePath : `./${relative}`;
}
