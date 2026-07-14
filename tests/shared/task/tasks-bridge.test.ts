import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeArtifact } from "../../../extensions/_shared/artifacts.js";
import {
  createTaskFromApprovedPrompt,
  exportTodosToProjectTask,
  formatTaskLifecyclePlan,
  formatCurrentProjectTaskResolution,
  importTodosFromProjectTasks,
  loadTaskBridgeSnapshot,
  planTaskLifecycleTransition,
  resolveCurrentProjectTask,
  writeCompletionNoteWithApproval,
} from "../../../extensions/_shared/task-bridge.js";
import { sharedState } from "../../../extensions/_shared/state.js";
import { createHarness } from "../../test-harness.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempProject(): string {
  const root = path.join(tmpdir(), `locus-pi-task-bridge-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  tempRoots.push(root);
  writeFileSync(path.join(root, ".tasks", "index.json"), JSON.stringify({
    schema: "index.v1",
    generated_at: "2026-06-02T00:00:00.000Z",
    tasks: [
      {
        id: "T-1",
        title: "Active task",
        status: "doing",
        type: "feature",
        path: "T-1-active-task",
        subtasks: [
          {
            id: "T-1-a",
            title: "Completed subtask",
            status: "done",
            type: "feature",
            path: "T-1-active-task/subtasks/T-1-a-completed-subtask",
          },
        ],
      },
      {
        id: "T-2",
        title: "Planned task",
        status: "planned",
        type: "feature",
        path: "T-2-planned-task",
      },
    ],
  }, null, 2));
  return root;
}

function lifecycleProject(): string {
  const root = path.join(tmpdir(), `locus-pi-task-lifecycle-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  tempRoots.push(root);
  writeFileSync(path.join(root, ".tasks", "index.json"), JSON.stringify({
    schema: "index.v1",
    generated_at: "2026-06-17T00:00:00.000Z",
    tasks: [
      {
        id: "T-1",
        title: "Draft task",
        status: "draft",
        type: "feature",
        path: "T-1-draft-task",
      },
      {
        id: "T-2",
        title: "Doing task",
        status: "doing",
        type: "feature",
        path: "T-2-doing-task",
      },
      {
        id: "T-3",
        title: "Review task",
        status: "review",
        type: "feature",
        path: "T-3-review-task",
      },
      {
        id: "T-4",
        title: "Ready to close",
        status: "review",
        type: "feature",
        path: "T-4-ready-to-close",
      },
    ],
  }, null, 2));
  writeLifecycleTaskWorkspace(root, "T-3-review-task", "## Closure\n\nTODO\n", "Reviewed without acceptance.\n");
  writeLifecycleTaskWorkspace(root, "T-4-ready-to-close", "## Closure\n\nShipped the lifecycle planner.\n", "ACCEPTED\n");
  return root;
}

function currentTaskProject(tasks: unknown[]): string {
  const root = path.join(tmpdir(), `locus-pi-current-task-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  tempRoots.push(root);
  writeFileSync(path.join(root, ".tasks", "index.json"), JSON.stringify({
    schema: "index.v1",
    generated_at: "2026-06-17T00:00:00.000Z",
    tasks,
  }, null, 2));
  return root;
}

function writeLifecycleTaskWorkspace(root: string, taskPath: string, taskMarkdown: string, qaMarkdown?: string): void {
  const taskDir = path.join(root, ".tasks", taskPath);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "task.md"), taskMarkdown);
  if (qaMarkdown !== undefined) writeFileSync(path.join(taskDir, "qa.md"), qaMarkdown);
}

function approvedArtifact(root: string): RuntimeArtifact {
  return {
    id: "prepared-draft-1",
    path: path.join(root, ".locus", "runtime", "artifacts", "prepared-draft-1.json"),
    kind: "prepared-task-draft",
    content: "# Prepared Task Draft\n\nDo work.",
    createdAt: "2026-06-02T00:00:00.000Z",
    sessionId: "prepare-session",
    draftId: "draft-1",
    metadata: {
      status: "approved",
      originalRequest: "Do work",
    },
  };
}

describe("task bridge", () => {
  it("parses .tasks/index.json and imports project tasks as session todos", () => {
    const root = tempProject();

    const snapshot = loadTaskBridgeSnapshot(root);
    const todos = importTodosFromProjectTasks(snapshot.tasks);

    expect(snapshot.tasks.map((task) => `${task.id}:${task.status}`)).toEqual(["T-1:doing", "T-1-a:done", "T-2:planned"]);
    expect(todos).toEqual([
      {
        name: "Project tasks",
        tasks: [
          { content: "T-1: Active task", status: "in_progress" },
          { content: "T-1-a: Completed subtask", status: "completed" },
          { content: "T-2: Planned task", status: "pending" },
        ],
      },
    ]);
    expect(existsSync(path.join(root, ".tasks", "T-3-new-task"))).toBe(false);
  });

  it("resolves the unique current doing project task from .tasks/index.json", () => {
    const root = currentTaskProject([
      { id: "T-1", title: "Review task", status: "review", type: "feature", path: "T-1-review-task" },
      { id: "T-2", title: "Doing task", status: "doing", type: "feature", path: "T-2-doing-task" },
      { id: "T-3", title: "Planned task", status: "planned", type: "feature", path: "T-3-planned-task" },
    ]);

    const resolution = resolveCurrentProjectTask(root);

    expect(resolution).toMatchObject({
      ok: true,
      taskId: "T-2",
      taskTitle: "Doing task",
      taskPath: "T-2-doing-task",
      currentStatus: "doing",
      taskKind: "task",
      selectionRule: "highest unique status in doing > review > planning > planned",
      message: "Resolved from .tasks/index.json only.",
    });
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("taskId: T-2");
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("currentStatus: doing");
  });

  it("returns no-current-task when only terminal or blocked tasks exist", () => {
    const root = currentTaskProject([
      { id: "T-1", title: "Blocked task", status: "blocked", type: "feature", path: "T-1-blocked-task" },
      { id: "T-2", title: "Closed task", status: "done", type: "feature", path: "T-2-closed-task" },
      { id: "T-3", title: "Rejected task", status: "wontdo", type: "feature", path: "T-3-rejected-task" },
    ]);

    const resolution = resolveCurrentProjectTask(root);

    expect(resolution).toMatchObject({
      ok: false,
      code: "no-current-task",
      candidates: [],
      message: "No current project task is available in .tasks/index.json.",
    });
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("code: no-current-task");
  });

  it("fails closed when the highest current status has multiple project tasks", () => {
    const root = currentTaskProject([
      { id: "T-1", title: "First doing task", status: "doing", type: "feature", path: "T-1-first-doing-task" },
      { id: "T-2", title: "Second doing task", status: "doing", type: "feature", path: "T-2-second-doing-task" },
      { id: "T-3", title: "Review task", status: "review", type: "feature", path: "T-3-review-task" },
    ]);

    const resolution = resolveCurrentProjectTask(root);

    expect(resolution).toMatchObject({
      ok: false,
      code: "multiple-current-tasks",
      candidates: [
        { taskId: "T-1", currentStatus: "doing" },
        { taskId: "T-2", currentStatus: "doing" },
      ],
      message: "Multiple doing project tasks exist in .tasks/index.json.",
    });
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("candidates:");
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("- T-1 (doing, task)");
  });

  it("resolves nested subtasks explicitly when the subtask is the current task", () => {
    const root = currentTaskProject([
      {
        id: "T-1",
        title: "Parent task",
        status: "blocked",
        type: "feature",
        path: "T-1-parent-task",
        subtasks: [
          {
            id: "T-1-a",
            title: "Current subtask",
            status: "doing",
            type: "feature",
            path: "T-1-parent-task/subtasks/T-1-a-current-subtask",
          },
        ],
      },
    ]);

    const resolution = resolveCurrentProjectTask(root);

    expect(resolution).toMatchObject({
      ok: true,
      taskId: "T-1-a",
      taskTitle: "Current subtask",
      taskPath: "T-1-parent-task/subtasks/T-1-a-current-subtask",
      currentStatus: "doing",
      taskKind: "subtask",
      parentId: "T-1",
    });
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("taskKind: subtask");
    expect(formatCurrentProjectTaskResolution(resolution)).toContain("parentId: T-1");
  });

  it("does not let session todos override project task truth", () => {
    const root = currentTaskProject([
      { id: "T-1", title: "Blocked project task", status: "blocked", type: "feature", path: "T-1-blocked-project-task" },
    ]);
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    sharedState.todos = [{
      name: "Execution",
      tasks: [{ content: "Session-only active todo", status: "in_progress" }],
    }];
    const beforeTodos = JSON.parse(JSON.stringify(sharedState.todos));

    const resolution = resolveCurrentProjectTask(root);

    expect(resolution).toMatchObject({ ok: false, code: "no-current-task" });
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
    expect(sharedState.todos).toEqual(beforeTodos);
  });

  it("creates a project task only from an approved prompt artifact", () => {
    const root = tempProject();

    const workspace = createTaskFromApprovedPrompt({
      projectRoot: root,
      artifact: approvedArtifact(root),
      taskId: "T-3",
      title: "Created from prompt",
      now: "2026-06-02T00:00:00.000Z",
    });

    expect(readFileSync(workspace.taskPath, "utf8")).toContain("Source artifact:");
    expect(readFileSync(workspace.taskPath, "utf8")).toContain("Source session: prepare-session");
    expect(readFileSync(workspace.eventsPath, "utf8")).toContain("\"actor\":\"task-bridge\"");
    expect(() => createTaskFromApprovedPrompt({
      projectRoot: root,
      artifact: { ...approvedArtifact(root), id: "draft-2", metadata: { status: "draft" } },
      taskId: "T-4",
      title: "Draft artifact",
    })).toThrow("Task bridge requires an approved prompt artifact.");
  });

  it("writes completion notes while delegating write permission to Pi", async () => {
    const root = tempProject();
    const workspace = createTaskFromApprovedPrompt({
      projectRoot: root,
      artifact: approvedArtifact(root),
      taskId: "T-3",
      title: "Created from prompt",
    });
    const h = createHarness(root);

    const legacyDenyTier = await writeCompletionNoteWithApproval({
      pi: h.pi,
      ctx: h.ctx,
      workspace,
      note: "Do not write this.",
      approvalTier: "deny",
    });
    const approved = await writeCompletionNoteWithApproval({
      pi: h.pi,
      ctx: h.ctx,
      workspace,
      note: "Verified completion.",
      approvalTier: "allow",
    });

    expect(legacyDenyTier).toMatchObject({ approved: true, reason: "Pi approval owns filesystem write decisions." });
    expect(approved.approved).toBe(true);
    expect(readFileSync(approved.artifactPath!, "utf8")).toContain("Verified completion.");
    expect(h.entries.filter((entry) => entry.type === "decision")).toHaveLength(0);
  });

  it("exports session todos as project-task markdown without changing .tasks", () => {
    const root = tempProject();
    const before = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");

    const markdown = exportTodosToProjectTask([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect task contract", status: "completed" },
          { content: "Run focused checks", status: "pending" },
        ],
      },
    ]);

    expect(markdown).toContain("## Execution");
    expect(markdown).toContain("- [x] Inspect task contract");
    expect(markdown).toContain("- [ ] Run focused checks");
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(before);
  });

  it("does not auto-sync or write todo or runtime state while planning lifecycle transitions", () => {
    const root = tempProject();
    const indexPath = path.join(root, ".tasks", "index.json");
    const runtimeFile = path.join(root, ".locus", "runtime", "task-lifecycle", "sentinel.txt");
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    writeFileSync(runtimeFile, "before\n");
    const beforeIndex = readFileSync(indexPath, "utf8");
    const beforeRuntime = readFileSync(runtimeFile, "utf8");
    sharedState.todos = [{
      name: "Execution",
      tasks: [{ content: "Existing todo", status: "pending" }],
    }];
    const beforeTodos = JSON.parse(JSON.stringify(sharedState.todos));

    const plan = planTaskLifecycleTransition(root, "T-1", "review");

    expect(plan).toMatchObject({ ok: true, taskId: "T-1", targetStatus: "review" });
    expect(readFileSync(indexPath, "utf8")).toBe(beforeIndex);
    expect(readFileSync(runtimeFile, "utf8")).toBe(beforeRuntime);
    expect(sharedState.todos).toEqual(beforeTodos);
  });

  it("plans allowed lifecycle transitions and keeps task files unchanged", () => {
    const root = lifecycleProject();
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    const beforeTask = readFileSync(path.join(root, ".tasks", "T-4-ready-to-close", "task.md"), "utf8");
    const beforeQa = readFileSync(path.join(root, ".tasks", "T-4-ready-to-close", "qa.md"), "utf8");

    const plan = planTaskLifecycleTransition(root, "T-1", "planned");

    expect(plan).toMatchObject({
      ok: true,
      dryRun: true,
      taskId: "T-1",
      taskTitle: "Draft task",
      taskPath: "T-1-draft-task",
      currentStatus: "draft",
      targetStatus: "planned",
      message: "Dry-run only. `locus task update` remains the mutation path.",
    });
    expect(formatTaskLifecyclePlan(plan)).toContain("Task lifecycle dry-run");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskId: T-1");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskTitle: Draft task");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskPath: T-1-draft-task");
    expect(formatTaskLifecyclePlan(plan)).toContain("currentStatus: draft");
    expect(formatTaskLifecyclePlan(plan)).toContain("targetStatus: planned");
    expect(formatTaskLifecyclePlan(plan)).toContain("message: Dry-run only. `locus task update` remains the mutation path.");
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
    expect(readFileSync(path.join(root, ".tasks", "T-4-ready-to-close", "task.md"), "utf8")).toBe(beforeTask);
    expect(readFileSync(path.join(root, ".tasks", "T-4-ready-to-close", "qa.md"), "utf8")).toBe(beforeQa);
  });

  it("rejects unsupported lifecycle transitions", () => {
    const root = lifecycleProject();

    const plan = planTaskLifecycleTransition(root, "T-2", "planned");

    expect(plan).toMatchObject({
      ok: false,
      dryRun: true,
      code: "unsupported-transition",
      taskId: "T-2",
      taskTitle: "Doing task",
      taskPath: "T-2-doing-task",
      currentStatus: "doing",
      targetStatus: "planned",
      allowedTargets: ["review", "blocked", "wontdo"],
      message: "Transition from doing to planned is unsupported.",
    });
    expect(formatTaskLifecyclePlan(plan)).toContain("code: unsupported-transition");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskId: T-2");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskTitle: Doing task");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskPath: T-2-doing-task");
    expect(formatTaskLifecyclePlan(plan)).toContain("currentStatus: doing");
    expect(formatTaskLifecyclePlan(plan)).toContain("targetStatus: planned");
    expect(formatTaskLifecyclePlan(plan)).toContain("allowedTargets: review, blocked, wontdo");
  });

  it("returns missing-task for unknown task ids", () => {
    const root = lifecycleProject();

    const plan = planTaskLifecycleTransition(root, "T-404", "doing");

    expect(plan).toMatchObject({
      ok: false,
      dryRun: true,
      code: "missing-task",
      taskId: "T-404",
      targetStatus: "doing",
    });
    expect(formatTaskLifecyclePlan(plan)).toContain("code: missing-task");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskId: T-404");
  });

  it("fails done transitions when QA and Closure preconditions are missing", () => {
    const root = lifecycleProject();

    const plan = planTaskLifecycleTransition(root, "T-3", "done");

    expect(plan).toMatchObject({
      ok: false,
      dryRun: true,
      code: "done-precondition-failed",
      taskId: "T-3",
      taskTitle: "Review task",
      taskPath: "T-3-review-task",
      currentStatus: "review",
      targetStatus: "done",
      missingPreconditions: ["qa.md missing ACCEPTED", "task.md missing non-placeholder Closure text"],
      message: "Transition to done is blocked until all preconditions pass.",
    });
    expect(formatTaskLifecyclePlan(plan)).toContain("code: done-precondition-failed");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskId: T-3");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskTitle: Review task");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskPath: T-3-review-task");
    expect(formatTaskLifecyclePlan(plan)).toContain("missingPreconditions:");
    expect(formatTaskLifecyclePlan(plan)).toContain("- qa.md missing ACCEPTED");
    expect(formatTaskLifecyclePlan(plan)).toContain("- task.md missing non-placeholder Closure text");
  });

  it("allows done transitions only when QA and Closure preconditions are satisfied", () => {
    const root = lifecycleProject();

    const plan = planTaskLifecycleTransition(root, "T-4", "done");

    expect(plan).toMatchObject({
      ok: true,
      dryRun: true,
      taskId: "T-4",
      taskTitle: "Ready to close",
      taskPath: "T-4-ready-to-close",
      currentStatus: "review",
      targetStatus: "done",
      message: "Dry-run only. `locus task update` remains the mutation path.",
    });
    expect(formatTaskLifecyclePlan(plan)).toContain("taskId: T-4");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskTitle: Ready to close");
    expect(formatTaskLifecyclePlan(plan)).toContain("taskPath: T-4-ready-to-close");
    expect(formatTaskLifecyclePlan(plan)).toContain("currentStatus: review");
    expect(formatTaskLifecyclePlan(plan)).toContain("targetStatus: done");
    expect(formatTaskLifecyclePlan(plan)).toContain("message: Dry-run only. `locus task update` remains the mutation path.");
  });
});
