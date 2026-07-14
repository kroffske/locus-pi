import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROJECT_TASK_STATUSES = ["draft", "planned", "planning", "doing", "review", "blocked", "done", "wontdo"] as const;
export type ProjectTaskStatus = typeof PROJECT_TASK_STATUSES[number];

export interface ProjectTaskIndexEntry {
  id: string;
  title: string;
  status: ProjectTaskStatus;
  type: string;
  priority?: string;
  owner?: string;
  path: string;
  parent_id?: string;
  work_items_total?: number;
  work_items_done?: number;
  work_items_remaining?: string[];
  subtasks?: ProjectTaskIndexEntry[];
}

export interface ProjectTaskIndex {
  schema: "index.v1";
  generated_at: string;
  tasks: ProjectTaskIndexEntry[];
}

export interface ProjectTaskCreateInput {
  id: string;
  title: string;
  type?: string;
  priority?: string;
  owner?: string;
  status?: ProjectTaskStatus;
  outcome: string;
  sourceArtifactPath: string;
  sourceSessionId?: string;
  now?: string;
}

export interface ProjectTaskWorkspace {
  id: string;
  dir: string;
  taskPath: string;
  eventsPath: string;
}

export function tasksRoot(projectRoot: string): string {
  return path.join(projectRoot, ".tasks");
}

export function readProjectTaskIndex(root: string): ProjectTaskIndex {
  const indexPath = path.join(root, "index.json");
  const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.schema !== "index.v1" || !Array.isArray(parsed.tasks)) {
    throw new Error(`Unsupported task index: ${indexPath}`);
  }
  return parsed as unknown as ProjectTaskIndex;
}

export function flattenProjectTasks(index: ProjectTaskIndex): ProjectTaskIndexEntry[] {
  const flattened: ProjectTaskIndexEntry[] = [];
  const visit = (task: ProjectTaskIndexEntry, parentId?: string) => {
    const entry = parentId !== undefined && task.parent_id === undefined ? { ...task, parent_id: parentId } : task;
    flattened.push(entry);
    for (const subtask of task.subtasks ?? []) visit(subtask, entry.id);
  };
  for (const task of index.tasks) visit(task);
  return flattened;
}

export function createProjectTaskWorkspace(root: string, input: ProjectTaskCreateInput): ProjectTaskWorkspace {
  const now = input.now ?? new Date().toISOString();
  const status = input.status ?? "planned";
  const type = input.type ?? "feature";
  const dir = path.join(root, `${input.id}-${slugify(input.title)}`);
  if (existsSync(dir)) throw new Error(`Task workspace already exists: ${dir}`);
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  const taskPath = path.join(dir, "task.md");
  const eventsPath = path.join(dir, "events.jsonl");
  writeFileSync(taskPath, renderTaskMarkdown(input, status, type, now));
  writeFileSync(eventsPath, `${JSON.stringify({ ts: now, event: "created", actor: "task-bridge", data: { status, sourceArtifactPath: input.sourceArtifactPath } })}\n`);
  return { id: input.id, dir, taskPath, eventsPath };
}

export function writeTaskArtifact(workspaceDir: string, fileName: string, content: string): string {
  const artifactsDir = path.join(workspaceDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactPath = path.join(artifactsDir, fileName);
  writeFileSync(artifactPath, content.endsWith("\n") ? content : `${content}\n`);
  return artifactPath;
}

function renderTaskMarkdown(input: ProjectTaskCreateInput, status: ProjectTaskStatus, type: string, now: string): string {
  return [
    "---",
    "schema: task.v3",
    `id: ${input.id}`,
    `title: ${JSON.stringify(input.title)}`,
    `status: ${status}`,
    "review_required: none",
    `type: ${type}`,
    `priority: ${input.priority ?? "p2"}`,
    `owner: ${input.owner ?? "manager"}`,
    `created_at: "${now}"`,
    `updated_at: "${now}"`,
    "parent: null",
    "depends_on: []",
    "gstack_refs: {}",
    "---",
    "",
    `# ${input.id}: ${input.title}`,
    "",
    "## Outcome",
    "",
    input.outcome,
    "",
    "## Source",
    "",
    `Source artifact: ${input.sourceArtifactPath}`,
    ...(input.sourceSessionId === undefined ? [] : [`Source session: ${input.sourceSessionId}`]),
    "",
    "## Work items",
    "",
    "- [ ] W1: Review approved prompt artifact.",
    "- [ ] W2: Execute requested slice.",
    "- [ ] W3: Record verification evidence.",
    "",
    "## Closure",
    "",
  ].join("\n");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "task";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
