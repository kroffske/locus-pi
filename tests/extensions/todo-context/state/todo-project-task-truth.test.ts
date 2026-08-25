import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCurrentProjectTask } from "../../../../extensions/_shared/project/task-bridge.js";
import { todoStateCache } from "../../../../extensions/todo-context/state/todo-state-cache.js";

const tempRoots: string[] = [];

afterEach(() => {
  todoStateCache.phases = [];
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function blockedTaskProject(): string {
  const root = path.join(tmpdir(), `locus-pi-todo-task-truth-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  tempRoots.push(root);
  writeFileSync(
    path.join(root, ".tasks", "index.json"),
    JSON.stringify(
      {
        schema: "index.v1",
        generated_at: "2026-06-17T00:00:00.000Z",
        tasks: [
          {
            id: "T-1",
            title: "Blocked project task",
            status: "blocked",
            type: "feature",
            path: "T-1-blocked-project-task",
          },
        ],
      },
      null,
      2,
    ),
  );
  return root;
}

describe("todo context project-task boundary", () => {
  it("does not let session todos override project task truth", () => {
    const root = blockedTaskProject();
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    todoStateCache.phases = [
      {
        name: "Execution",
        tasks: [{ content: "Session-only active todo", status: "in_progress" }],
      },
    ];
    const beforeTodos = JSON.parse(JSON.stringify(todoStateCache.phases));

    const resolution = resolveCurrentProjectTask(root);

    expect(resolution).toMatchObject({ ok: false, code: "no-current-task" });
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
    expect(todoStateCache.phases).toEqual(beforeTodos);
  });
});
