import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeArtifact } from "../../../extensions/_shared/runtime/artifacts.js";
import {
  createTaskFromApprovedPrompt,
  exportTodosToProjectTask,
  formatCurrentProjectTaskResolution,
  importTodosFromProjectTasks,
  loadTaskBridgeSnapshot,
  resolveCurrentProjectTask,
  writeCompletionNoteWithApproval,
} from "../../../extensions/_shared/project/task-bridge.js";
import { createHarness } from "../../test-harness.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempProject(): string {
  const root = path.join(tmpdir(), `locus-pi-task-bridge-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  tempRoots.push(root);
  writeFileSync(
    path.join(root, ".tasks", "index.json"),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );
  return root;
}

function currentTaskProject(tasks: unknown[]): string {
  const root = path.join(tmpdir(), `locus-pi-current-task-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  tempRoots.push(root);
  writeFileSync(
    path.join(root, ".tasks", "index.json"),
    JSON.stringify(
      {
        schema: "index.v1",
        generated_at: "2026-06-17T00:00:00.000Z",
        tasks,
      },
      null,
      2,
    ),
  );
  return root;
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

    expect(snapshot.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      "T-1:doing",
      "T-1-a:done",
      "T-2:planned",
    ]);
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
    expect(readFileSync(workspace.eventsPath, "utf8")).toContain('"actor":"task-bridge"');
    expect(() =>
      createTaskFromApprovedPrompt({
        projectRoot: root,
        artifact: { ...approvedArtifact(root), id: "draft-2", metadata: { status: "draft" } },
        taskId: "T-4",
        title: "Draft artifact",
      }),
    ).toThrow("Task bridge requires an approved prompt artifact.");
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
});
