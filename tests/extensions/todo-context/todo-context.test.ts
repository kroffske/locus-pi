import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import todoContext from "../../../extensions/todo-context/index.js";
import { exportTodosToProjectTask } from "../../../extensions/_shared/task-bridge.js";
import { sharedState } from "../../../extensions/_shared/state.js";
import { createHarness, emit, runTool } from "../../test-harness.js";

describe("todo-context OMP-compatible todo_write", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    sharedState.todos = [];
    sharedState.todoContext = null;
    sharedState.todoAutoContinue = false;
    delete process.env.LOCUS_PI_SESSION_STORE;
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    delete process.env.LOCUS_PI_SESSION_STORE;
  });

  function tempRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "locus-pi-todo-"));
    tempRoots.push(root);
    return root;
  }

  interface ProjectTaskIndexEntry {
    id: string;
    title: string;
    status: string;
    type: string;
    path: string;
  }

  function explicitTaskProject(): string {
    const root = tempRoot();
    mkdirSync(path.join(root, ".tasks"), { recursive: true });
    writeFileSync(
      path.join(root, ".tasks", "index.json"),
      JSON.stringify(
        {
          schema: "index.v1",
          generated_at: "2026-06-17T00:00:00.000Z",
          tasks: [
            {
              id: "T-136",
              title: "Explicit task todo bridge command surface",
              status: "doing",
              type: "feature",
              path: "T-136-explicit-task-todo-bridge-command-surface",
            },
            {
              id: "T-137",
              title: "Follow-on task",
              status: "planned",
              type: "feature",
              path: "T-137-follow-on-task",
            },
          ],
        },
        null,
        2,
      ),
    );
    return root;
  }

  function projectWithTasks(tasks: ProjectTaskIndexEntry[]): string {
    const root = tempRoot();
    mkdirSync(path.join(root, ".tasks"), { recursive: true });
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

  function readTaskIndex(root: string): ProjectTaskIndexEntry[] {
    const index = JSON.parse(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")) as {
      tasks?: ProjectTaskIndexEntry[];
    };
    return index.tasks ?? [];
  }

  function readTaskRecord(root: string, taskId: string): ProjectTaskIndexEntry {
    const task = readTaskIndex(root).find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Missing task ${taskId}`);
    return task;
  }

  it("initializes pending tasks and auto-starts the first task", async () => {
    const h = createHarness();
    todoContext(h.pi);

    const result = await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract", "Patch wrapper"] }] }],
    });

    expect(result.isError).not.toBe(true);
    expect(result.details?.storage).toBe("session");
    expect(result.details?.activeTask).toBe("Inspect contract");
    expect(h.entries[0]?.type).toBe("todo_write");
    expect(result.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "in_progress" },
          { content: "Patch wrapper", status: "pending" },
        ],
      },
    ]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Remaining items (2):");
    expect(text).toContain("Inspect contract [in_progress] (Execution)");
  });

  it("persists queue context and dispatches exactly one hidden continuation after progress settles", async () => {
    const h = createHarness();
    todoContext(h.pi);

    const init = await runTool(h, "todo_write", {
      context: "Verify arithmetic one response at a time.",
      autoContinue: true,
      ops: [{ op: "init", list: [{ phase: "Checks", items: ["Add 2 + 2", "Add 3 + 4"] }] }],
    });

    expect(init.details).toMatchObject({
      queueContext: "Verify arithmetic one response at a time.",
      autoContinue: true,
      continuationArmed: true,
    });
    expect(h.sentMessages).toHaveLength(0);

    await emit(h, "agent_settled");

    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]).toMatchObject({
      message: {
        customType: "locus-todo-continuation",
        display: false,
      },
      options: {
        triggerTurn: true,
        deliverAs: "followUp",
      },
    });
    expect(h.sentMessages[0]?.message.content).toContain("Queue context:\nVerify arithmetic one response at a time.");
    expect(h.sentMessages[0]?.message.content).toContain("Active todo: Add 2 + 2");
    expect(h.sentUserMessages).toHaveLength(0);

    await emit(h, "agent_settled");
    expect(h.sentMessages).toHaveLength(1);

    await runTool(h, "todo_write", { ops: [{ op: "done", task: "Add 2 + 2" }] });
    await runTool(h, "todo_write", {
      ops: [{ op: "note", task: "Add 2 + 2", text: "Result: 4." }],
    });
    await emit(h, "agent_settled");
    expect(h.sentMessages).toHaveLength(2);
    expect(h.sentMessages[1]?.message.content).toContain("Active todo: Add 3 + 4");

    const completed = await runTool(h, "todo_write", { ops: [{ op: "done", task: "Add 3 + 4" }] });
    expect(completed.details).toMatchObject({ autoContinue: false, continuationArmed: false });
    await emit(h, "agent_settled");
    expect(h.sentMessages).toHaveLength(2);
  });

  it("keeps manual mode non-dispatching and lets /todo run and /todo pause control execution", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Checks", items: ["Add 2 + 2"] }] }],
    });
    await emit(h, "agent_settled");
    expect(h.sentMessages).toHaveLength(0);

    await runCommand(h, "todo", "run Small arithmetic smoke");
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]?.message.content).toContain("Queue context:\nSmall arithmetic smoke");
    expect(h.widgets.get("todo")).toContain("Autonomous todo execution started.");

    await runCommand(h, "todo", "pause");
    expect(h.widgets.get("todo")).toContain("Autonomous todo execution paused.");
    expect(h.entries[0]?.data).toMatchObject({
      metadata: {
        context: "Small arithmetic smoke",
        autoContinue: false,
      },
    });
  });

  it("pauses without losing the active task when continuation transport fails", async () => {
    const h = createHarness();
    todoContext(h.pi);
    h.pi.sendMessage = async () => {
      throw new Error("follow-up transport failed");
    };

    await runTool(h, "todo_write", {
      autoContinue: true,
      ops: [{ op: "init", list: [{ phase: "Checks", items: ["Add 2 + 2"] }] }],
    });
    await emit(h, "agent_settled");

    expect(h.widgets.get("todo")).toContain("Autonomous execution paused");
    expect(h.widgets.get("todo")).toContain("follow-up transport failed");
    expect(h.entries[0]?.data).toMatchObject({
      phases: [
        {
          name: "Checks",
          tasks: [{ content: "Add 2 + 2", status: "in_progress" }],
        },
      ],
      metadata: { autoContinue: false },
    });
  });

  it("pauses after the bounded continuation limit", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      autoContinue: true,
      ops: [{ op: "init", list: [{ phase: "Checks", items: ["Repeat bounded check"] }] }],
    });

    for (let index = 0; index < 20; index++) {
      await emit(h, "agent_settled");
      expect(h.sentMessages).toHaveLength(index + 1);
      await runTool(h, "todo_write", {
        ops: [{ op: "start", task: "Repeat bounded check" }],
      });
    }
    await emit(h, "agent_settled");

    expect(h.sentMessages).toHaveLength(20);
    expect(h.widgets.get("todo")).toContain("paused after 20 continuations");
    expect(h.entries[0]?.data).toMatchObject({ metadata: { autoContinue: false } });
  });

  it("loads legacy phase-only entries with autonomous mode disabled", async () => {
    const h = createHarness();
    h.entries.unshift({
      type: "todo_write",
      data: {
        phases: [
          {
            name: "Legacy",
            tasks: [{ content: "Keep old state readable", status: "in_progress" }],
          },
        ],
      },
    });
    todoContext(h.pi);

    const result = await runTool(h, "todo_write", {
      ops: [{ op: "note", task: "Keep old state readable", text: "Restored." }],
    });
    await emit(h, "agent_settled");

    expect(result.details).toMatchObject({
      todoStateSource: "pi-entry",
      autoContinue: false,
      continuationArmed: false,
    });
    expect(h.sentMessages).toHaveLength(0);
  });

  it("marks phase tasks completed and reports completion transitions", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract", "Patch wrapper"] }] }],
    });

    const result = await runTool(h, "todo_write", { ops: [{ op: "done", phase: "Execution" }] });

    expect(result.isError).not.toBe(true);
    expect(result.details?.completedTasks).toEqual([
      { phase: "Execution", content: "Inspect contract" },
      { phase: "Execution", content: "Patch wrapper" },
    ]);
    expect(result.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "completed" },
          { content: "Patch wrapper", status: "completed" },
        ],
      },
    ]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Remaining items: none.");
  });

  it("restores previous todos from session entries instead of process memory", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract", "Patch wrapper"] }] }],
    });
    sharedState.todos = [];

    const result = await runTool(h, "todo_write", { ops: [{ op: "done", task: "Inspect contract" }] });

    expect(result.isError).not.toBe(true);
    expect(result.details?.storage).toBe("session");
    expect(result.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "completed" },
          { content: "Patch wrapper", status: "in_progress" },
        ],
      },
    ]);
    expect(result.details?.completedTasks).toEqual([{ phase: "Execution", content: "Inspect contract" }]);
  });

  it("persists and replays todos through the JSONL session store", async () => {
    process.env.LOCUS_PI_SESSION_STORE = "jsonl";
    const root = tempRoot();
    const first = createHarness(root, { sessionId: "todo-jsonl-session" });
    todoContext(first.pi);

    const init = await runTool(first, "todo_write", {
      context: "Persist across JSONL restore.",
      autoContinue: true,
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract", "Patch wrapper"] }] }],
    });
    expect(init.details).toMatchObject({
      storage: "session",
      storageBackend: "jsonl",
      todoStateSource: "memory",
      queueContext: "Persist across JSONL restore.",
      autoContinue: true,
    });

    sharedState.todos = [];
    sharedState.todoContext = null;
    sharedState.todoAutoContinue = false;
    const second = createHarness(root, { sessionId: "todo-jsonl-session" });
    todoContext(second.pi);
    const restored = await runTool(second, "todo_write", { ops: [{ op: "done", task: "Inspect contract" }] });

    expect(restored.details).toMatchObject({
      storage: "session",
      storageBackend: "jsonl",
      todoStateSource: "jsonl",
      queueContext: "Persist across JSONL restore.",
      autoContinue: true,
    });
    expect(restored.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "completed" },
          { content: "Patch wrapper", status: "in_progress" },
        ],
      },
    ]);
  });

  it("persists mutated state even when a later operation returns an error", async () => {
    const h = createHarness();
    todoContext(h.pi);

    const result = await runTool(h, "todo_write", {
      ops: [
        { op: "init", list: [{ phase: "Execution", items: ["Inspect contract"] }] },
        { op: "done", task: "Missing task" },
      ],
    });

    expect(result.isError).toBe(true);
    sharedState.todos = [];
    const restored = await runTool(h, "todo_write", {
      ops: [{ op: "append", phase: "Execution", items: ["Patch wrapper"] }],
    });
    expect(restored.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "in_progress" },
          { content: "Patch wrapper", status: "pending" },
        ],
      },
    ]);
  });

  it("shows and mutates todos through the OMP-style /todo command", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "todo", "append Execution inspect contract");
    await runCommand(h, "todo", "done inspect");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("[CHANGE] Session todos");
    expect(widget).toContain("Marked completed: Inspect contract");
    expect(widget).not.toContain("# Execution");
    expect(widget).toContain("Body: /todo export");
    await runCommand(h, "todo", "show");
    expect(h.widgets.get("todo")).toContain("[VIEW] Session todos");
    expect(h.widgets.get("todo")).toContain("- [x] Inspect contract");
    expect(h.entries[0]?.type).toBe("todo_write");
  });

  it("appends a delimiter-separated batch atomically", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "todo", "append Checks add 2 + 2 ;; add 3 + 4 ;; add 5 + 6");

    expect(h.widgets.get("todo")).toContain("Appended 3 tasks to Checks.");
    expect(h.entries[0]?.data).toMatchObject({
      phases: [
        {
          name: "Checks",
          tasks: [
            { content: "Add 2 + 2", status: "in_progress" },
            { content: "Add 3 + 4", status: "pending" },
            { content: "Add 5 + 6", status: "pending" },
          ],
        },
      ],
    });
    const entriesBefore = h.entries.length;

    await runCommand(h, "todo", "append Checks add 7 + 8 ;; ;; add 9 + 10");

    expect(h.widgets.get("todo")).toContain("state was not changed");
    expect(h.entries).toHaveLength(entriesBefore);
  });

  it("shows the todo state backend in /todo output", async () => {
    process.env.LOCUS_PI_SESSION_STORE = "jsonl";
    const h = createHarness(tempRoot(), { sessionId: "todo-command-session" });
    todoContext(h.pi);

    await runCommand(h, "todo", "append Execution inspect contract");
    await runCommand(h, "todo", "show");

    expect(h.widgets.get("todo")).toContain("storageBackend: jsonl");
    expect(h.widgets.get("todo")).toContain("- [/] Inspect contract");
  });

  it("shows the current project task without mutating session todos or .tasks", async () => {
    const root = explicitTaskProject();
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    const h = createHarness(root);
    todoContext(h.pi);

    await runCommand(h, "todo", "current-task");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("Current project task");
    expect(widget).toContain("ok: true");
    expect(widget).toContain("taskId: T-136");
    expect(widget).toContain("taskTitle: Explicit task todo bridge command surface");
    expect(widget).toContain("currentStatus: doing");
    expect(widget).toContain("message: Resolved from .tasks/index.json only.");
    expect(h.entries).toHaveLength(0);
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
  });

  it("does not let an active session todo override unresolved project task truth", async () => {
    const root = projectWithTasks([
      {
        id: "T-200",
        title: "Blocked task",
        status: "blocked",
        type: "feature",
        path: "T-200-blocked-task",
      },
    ]);
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    const h = createHarness(root);
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Session active todo"] }] }],
    });

    await runCommand(h, "todo", "current-task");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("ok: false");
    expect(widget).toContain("code: no-current-task");
    expect(widget).toContain("No current project task is available in .tasks/index.json.");
    expect(h.entries.filter((entry) => entry.type === "todo_write")).toHaveLength(1);
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
  });

  it("seeds session todos from an exact task without mutating .tasks", async () => {
    const root = explicitTaskProject();
    const task = readTaskRecord(root, "T-136");
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    const h = createHarness(root);
    todoContext(h.pi);

    await runCommand(h, "todo", "from-task T-136");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("[CHANGE] Session todos");
    expect(widget).toContain("Seeded session todos from task T-136");
    expect(widget).not.toContain("# Project tasks");
    expect(widget).toContain(`taskPath: ./.tasks/${task.path}/task.md`);
    expect(h.entries[0]?.type).toBe("todo_write");
    expect(h.entries[0]?.data).toMatchObject({
      phases: [
        {
          name: "Project tasks",
          tasks: [{ content: "T-136: Explicit task todo bridge command surface", status: "in_progress" }],
        },
      ],
    });
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
  });

  it("writes completion notes from current session todos to an explicit task without mutating task status", async () => {
    const root = explicitTaskProject();
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");
    const task = readTaskRecord(root, "T-136");
    const h = createHarness(root);
    todoContext(h.pi);

    await runCommand(h, "todo", "from-task T-136");
    await runCommand(h, "todo", "append Verification Capture current session markdown");
    await runCommand(h, "todo", "completion-note --yes T-136");

    const artifactPath = path.join(root, ".tasks", task.path, "artifacts", "completion-note.md");
    const artifact = readFileSync(artifactPath, "utf8");
    const expectedArtifact = exportTodosToProjectTask([
      {
        name: "Project tasks",
        tasks: [{ content: "T-136: Explicit task todo bridge command surface", status: "in_progress" }],
      },
      {
        name: "Verification",
        tasks: [{ content: "Capture current session markdown", status: "pending" }],
      },
    ]);

    expect(h.widgets.get("todo")).toContain("Completion note written for task T-136.");
    expect(h.widgets.get("todo")).toContain("permission: delegated-to-pi");
    expect(h.widgets.get("todo")).toContain("artifact: completion-note.md");
    expect(h.widgets.get("todo")).toContain("target: task:T-136");
    expect(artifact).toBe(expectedArtifact);
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
    expect(readTaskRecord(root, "T-136").status).toBe("doing");
  });

  it("fails clearly when an explicit task is missing", async () => {
    const root = explicitTaskProject();
    const beforeIndex = readFileSync(path.join(root, ".tasks", "index.json"), "utf8");

    const fromTaskHarness = createHarness(root);
    todoContext(fromTaskHarness.pi);
    await runCommand(fromTaskHarness, "todo", "from-task T-136");
    await runCommand(fromTaskHarness, "todo", "from-task T-404");
    expect(fromTaskHarness.widgets.get("todo")).toContain("todo from-task failed.");
    expect(fromTaskHarness.widgets.get("todo")).toContain("Task target T-404 was not found in .tasks/index.json.");
    expect(fromTaskHarness.widgets.get("todo")).toContain("No session todos were changed.");
    expect(fromTaskHarness.widgets.get("todo")).not.toContain("Seeded session todos from task T-136");
    expect(fromTaskHarness.entries.filter((entry) => entry.type === "todo_write")).toHaveLength(1);

    const completionHarness = createHarness(root);
    todoContext(completionHarness.pi);
    await runCommand(completionHarness, "todo", "completion-note --yes T-404");
    expect(completionHarness.widgets.get("todo")).toContain("todo completion-note failed.");
    expect(completionHarness.widgets.get("todo")).toContain("Task target T-404 was not found in .tasks/index.json.");
    expect(completionHarness.widgets.get("todo")).toContain("No session todos were changed.");
    expect(completionHarness.entries).toHaveLength(0);
    expect(readFileSync(path.join(root, ".tasks", "index.json"), "utf8")).toBe(beforeIndex);
  });

  it("edits todos as Markdown through the /todo command", async () => {
    const h = createHarness();
    todoContext(h.pi);
    h.ctx.ui.editor = (async () =>
      "# Review\n- [ ] Inspect OMP todo command\n  > Keep source evidence\n") as unknown as typeof h.ctx.ui.editor;

    await runCommand(h, "todo", "edit");

    expect(h.widgets.get("todo")).toContain("Todos updated from editor: 1 phase(s), 1 task(s).");
    expect(h.entries[0]?.data).toMatchObject({
      phases: [
        {
          name: "Review",
          tasks: [
            {
              content: "Inspect OMP todo command",
              status: "in_progress",
              notes: ["Keep source evidence"],
            },
          ],
        },
      ],
    });
  });

  it("treats an undefined host editor result as cancellation without mutating session state", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "todo", "append Execution preserve state");
    const entriesBefore = h.entries.length;
    h.ctx.ui.editor = (async () => undefined) as unknown as typeof h.ctx.ui.editor;

    await runCommand(h, "todo", "edit");

    expect(h.widgets.get("todo")).toContain("[RESULT] Session todos");
    expect(h.widgets.get("todo")).toContain("Cancelled; session todos were not changed.");
    expect(h.widgetOptions.get("todo")).toEqual({ placement: "aboveEditor" });
    expect(h.entries).toHaveLength(entriesBefore);
    await runCommand(h, "todo", "show");
    expect(h.widgets.get("todo")).toContain("Preserve state");
  });

  it("rejects malformed editor Markdown without committing partial state", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "todo", "append Execution preserve state");
    const entriesBefore = h.entries.length;
    h.ctx.ui.editor = (async () => "this is not todo markdown") as unknown as typeof h.ctx.ui.editor;

    await runCommand(h, "todo", "edit");

    expect(h.widgets.get("todo")).toContain("[WARN] Session todos");
    expect(h.widgets.get("todo")).toContain("state was not changed");
    expect(h.widgetOptions.get("todo")).toEqual({ placement: "aboveEditor" });
    expect(h.notifications).toHaveLength(0);
    expect(h.entries).toHaveLength(entriesBefore);
    await runCommand(h, "todo", "show");
    expect(h.widgets.get("todo")).toContain("Preserve state");
  });

  it("renders an ERROR card when the host editor fails without claiming a change", async () => {
    const h = createHarness();
    todoContext(h.pi);
    h.ctx.ui.editor = (async () => {
      throw new Error("editor transport failed");
    }) as unknown as typeof h.ctx.ui.editor;

    await runCommand(h, "todo", "edit");

    expect(h.widgets.get("todo")).toContain("[ERROR] Session todos");
    expect(h.widgets.get("todo")).toContain("no successful change is claimed");
    expect(h.widgets.get("todo")).toContain("editor transport failed");
    expect(h.notifications).toHaveLength(0);
    expect(h.entries).toHaveLength(0);
  });

  it("uses one typed warning for an unknown command without a duplicate host notification", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "todo", "unexpected");

    expect(h.widgets.get("todo")).toContain("[WARN] Session todos");
    expect(h.widgets.get("todo")).toContain("Unknown /todo verb: unexpected.");
    expect(h.notifications).toHaveLength(0);
  });

  it("returns OMP-style errors without dropping mutated todo state", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract"] }] }],
    });

    const result = await runTool(h, "todo_write", {
      ops: [
        { op: "done", task: "Missing task" },
        { op: "append", phase: "Execution", items: ["Patch wrapper"] },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "in_progress" },
          { content: "Patch wrapper", status: "pending" },
        ],
      },
    ]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('Errors: Task "Missing task" not found');
  });

  it("explains that task-like ids are not valid todo identifiers", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract"] }] }],
    });

    const result = await runTool(h, "todo_write", {
      ops: [{ op: "done", task: "task-1" }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('Task "task-1" not found. Tasks are referenced by content, not by IDs');
  });

  it("stores notes on the active task and renders active notes", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract"] }] }],
    });

    const result = await runTool(h, "todo_write", {
      ops: [{ op: "note", task: "Inspect contract", text: "Use OMP source truth.   " }],
    });

    expect(result.isError).not.toBe(true);
    expect(result.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          {
            content: "Inspect contract",
            status: "in_progress",
            notes: ["Use OMP source truth."],
          },
        ],
      },
    ]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("(+1 note)");
    expect(text).toContain("Use OMP source truth.");
  });

  it("exports deterministic Markdown from restored todo state", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract", "Patch wrapper"] }] }],
    });
    await runTool(h, "todo_write", {
      ops: [{ op: "note", task: "Inspect contract", text: "Keep source evidence.\nPreserve local limits." }],
    });
    sharedState.todos = [];

    await runCommand(h, "todo", "export");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("[VIEW] Session todos export");
    expect(widget).toContain("# Execution");
    expect(widget).toContain("- [/] Inspect contract");
    expect(widget).toContain("  > Preserve local limits.");
    expect(widget).toContain("- [ ] Patch wrapper");
  });

  it("clears all todos through /todo rm and keeps the empty state after reload", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "todo", "append Execution inspect contract");
    await runCommand(h, "todo", "rm");

    expect(h.widgets.get("todo")).toContain("[CHANGE] Session todos");
    expect(h.widgets.get("todo")).toContain("Cleared all todos.");
    expect(h.entries[0]?.data).toMatchObject({ phases: [] });
    sharedState.todos = [{ name: "Stale", tasks: [{ content: "Should not reappear", status: "pending" }] }];
    await runCommand(h, "todo", "show");
    expect(h.widgets.get("todo")).toContain("No todos. Use /todo append <task> to start one.");
  });

  it("renders the 13-line /todo help block in full via the factory widget path (T-178)", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "todo", "help");

    // (a) routed through the host-EXEMPT factory path, not the capped string[] path.
    expect(typeof h.widgetPayloads.get("todo")).toBe("function");
    const widget = h.widgets.get("todo") ?? "";
    // (b) the typed card preserves the primary help contract and reports
    // bounded overflow instead of silently dropping it.
    expect(widget).toContain("Usage: /todo <verb> [args]");
    expect(widget).toContain("[VIEW] Session todos help");
    expect(widget).toContain("hidden)");
    // (c) never emits the host's 10-line cap marker.
    expect(widget).not.toContain("widget truncated");
    // (e) docks under the input line.
    expect(h.widgetOptions.get("todo")?.placement).toBe("belowEditor");
  });

  it("clamps a long todo list to 14 lines with a '+N more' affordance via the factory widget (T-178)", async () => {
    const h = createHarness();
    todoContext(h.pi);

    for (let i = 1; i <= 20; i++) {
      await runCommand(h, "todo", `append Execution task number ${i}`);
    }
    await runCommand(h, "todo", "show");

    // (a) routed through the host-EXEMPT factory path, not the capped string[] path.
    expect(typeof h.widgetPayloads.get("todo")).toBe("function");
    const widget = h.widgets.get("todo") ?? "";
    // (b) carries the shared semantic hidden-count affordance instead of
    // silently dropping content.
    expect(widget).toContain("(+");
    expect(widget).toContain("hidden)");
    expect(widget).toContain("Body: /todo export");
    // (c) never emits the host's 10-line cap marker.
    expect(widget).not.toContain("widget truncated");
    // (d) docks under the input line.
    expect(h.widgetOptions.get("todo")?.placement).toBe("belowEditor");
    // (e) clamped to the shared terminal-height budget.
    expect(widget.split(/\r?\n/).length).toBeLessThanOrEqual(18);
  });

  it("keeps the RPC/plain Session todos projection semantic and below the host 10-line cap", async () => {
    const h = createHarness(tempRoot(), { mode: "rpc", sessionId: "todo-rpc-compact" });
    h.ctx.hasUI = true;
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [
        {
          op: "init",
          list: [{ phase: "Execution", items: Array.from({ length: 12 }, (_, index) => `Task ${index + 1}`) }],
        },
      ],
    });

    await runCommand(h, "todo", "show");

    const payload = h.widgetPayloads.get("todo");
    expect(Array.isArray(payload)).toBe(true);
    expect((payload as string[]).length).toBeLessThanOrEqual(10);
    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("[VIEW] Session todos");
    expect(widget).toContain("storageBackend:");
    expect(widget).toContain("hidden)");
    expect(widget).toContain("Body: /todo export");
    expect(widget).not.toContain("widget truncated");
  });

  async function runCommand(harness: ReturnType<typeof createHarness>, name: string, text: string): Promise<void> {
    const command = harness.commands.get(name);
    if (!command) throw new Error(`${name} command not registered`);
    await command.handler(text, harness.ctx);
  }
});
