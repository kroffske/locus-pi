import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import todoContext from "../../../extensions/todo-context/index.js";
import { sharedState } from "../../../extensions/_shared/state.js";
import { createHarness, emit, runTool } from "../../test-harness.js";

/**
 * tests/extensions/todo-context/todo-command-surfaces.test.ts — characterization
 * coverage for the `/todo` verbs, `todo_write` op errors, and autonomous-queue
 * refusals that `todo-context.test.ts` never reached.
 *
 * Written against the pre-split entrypoint and seen green there, so the T-126
 * relayout of `extensions/todo-context/` has evidence for its
 * behavior-preserving claim (D3).
 */
describe("todo-context command surfaces and op errors", () => {
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
    const root = mkdtempSync(path.join(tmpdir(), "locus-pi-todo-surfaces-"));
    tempRoots.push(root);
    return root;
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
          ],
        },
        null,
        2,
      ),
    );
    return root;
  }

  async function runCommand(harness: ReturnType<typeof createHarness>, text: string): Promise<void> {
    const command = harness.commands.get("todo");
    if (!command) throw new Error("todo command not registered");
    await command.handler(text, harness.ctx);
  }

  function toolText(result: Awaited<ReturnType<typeof runTool>>): string {
    return result.content[0]?.type === "text" ? result.content[0].text : "";
  }

  it("prints Markdown with a copy notice for /todo copy", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");

    await runCommand(h, "copy");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("[VIEW] Session todos");
    expect(widget).toContain("Copy not available here; printing Markdown instead.");
    expect(widget).toContain("- [/] Inspect contract");
  });

  it("starts a fuzzy-matched task and refuses an unmatched one", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");
    await runCommand(h, "append Execution patch wrapper");

    await runCommand(h, "start patch");
    expect(h.widgets.get("todo")).toContain("Started: Patch wrapper");

    await runCommand(h, "start nothing-here");
    expect(h.widgets.get("todo")).toContain('No task matched "nothing-here".');
  });

  it("drops a fuzzy-matched phase and every task when no target is given", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");
    await runCommand(h, "append Verification confirm output");

    await runCommand(h, "drop verif");
    expect(h.widgets.get("todo")).toContain("Marked abandoned: Verification");

    await runCommand(h, "drop");
    expect(h.widgets.get("todo")).toContain("Marked all tasks abandoned.");

    await runCommand(h, "show");
    expect(h.widgets.get("todo")).toContain("- [-] Inspect contract");
  });

  it("completes every task when /todo done has no target", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");

    await runCommand(h, "done");

    expect(h.widgets.get("todo")).toContain("Marked all tasks completed.");
  });

  it("removes a single fuzzy-matched task through /todo rm", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");
    await runCommand(h, "append Execution patch wrapper");

    await runCommand(h, "rm patch");

    expect(h.widgets.get("todo")).toContain("Removed: Patch wrapper");
    await runCommand(h, "show");
    expect(h.widgets.get("todo")).not.toContain("Patch wrapper");
  });

  it("refuses no-match, duplicate, oversized, and empty append input", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");
    const entriesBefore = h.entries.length;

    await runCommand(h, "done nothing-here");
    expect(h.widgets.get("todo")).toContain('No task or phase matched "nothing-here".');

    await runCommand(h, "append Execution inspect contract");
    expect(h.widgets.get("todo")).toContain('Task "Inspect contract" already exists; batch state was not changed.');

    const oversized = Array.from({ length: 21 }, (_, index) => `task ${index}`).join(" ;; ");
    await runCommand(h, `append ${oversized}`);
    expect(h.widgets.get("todo")).toContain("Append accepts at most 20 tasks at once; state was not changed.");

    await runCommand(h, "append");
    expect(h.widgets.get("todo")).toContain("Append requires a task in every batch segment; state was not changed.");

    await runCommand(h, 'append ""');
    expect(h.widgets.get("todo")).toContain("Append requires a task; state was not changed.");

    expect(h.entries).toHaveLength(entriesBefore);
  });

  it("refuses /todo run when no todo is active", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "run some context");

    expect(h.widgets.get("todo")).toContain("No active todo to run.");
    expect(h.sentMessages).toHaveLength(0);
  });

  it("reports an unavailable continuation transport and pauses the queue", async () => {
    const h = createHarness();
    todoContext(h.pi);
    delete (h.pi as { sendMessage?: unknown }).sendMessage;

    await runTool(h, "todo_write", {
      autoContinue: true,
      ops: [{ op: "init", list: [{ phase: "Checks", items: ["Add 2 + 2"] }] }],
    });
    await emit(h, "agent_settled");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("Autonomous execution is unavailable because this Pi host cannot trigger a");
    expect(widget).toContain("continuation turn.");
    expect(widget).toContain("The active item remains visible.");
    expect(h.entries[0]?.data).toMatchObject({ metadata: { autoContinue: false } });
  });

  it("reports each malformed todo_write operation without dropping state", async () => {
    const h = createHarness();
    todoContext(h.pi);

    expect(toolText(await runTool(h, "todo_write", { ops: [{ op: "init" }] }))).toContain(
      "Missing list for init operation",
    );
    expect(toolText(await runTool(h, "todo_write", { ops: [{ op: "append", items: ["Orphan"] }] }))).toContain(
      "Missing phase name for append operation",
    );
    expect(toolText(await runTool(h, "todo_write", { ops: [{ op: "append", phase: "Execution" }] }))).toContain(
      "Missing items for append operation",
    );
    expect(toolText(await runTool(h, "todo_write", { ops: [{ op: "start" }] }))).toContain("Missing task content");

    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract"] }] }],
    });
    expect(
      toolText(await runTool(h, "todo_write", { ops: [{ op: "note", task: "Inspect contract", text: "  " }] })),
    ).toContain("Missing text for note operation");
    expect(toolText(await runTool(h, "todo_write", { ops: [{ op: "done", phase: "Missing phase" }] }))).toContain(
      'Phase "Missing phase" not found',
    );
    expect(
      toolText(
        await runTool(h, "todo_write", { ops: [{ op: "append", phase: "Execution", items: ["Inspect contract"] }] }),
      ),
    ).toContain('Task "Inspect contract" already exists');

    const result = await runTool(h, "todo_write", { ops: [{ op: "rm", task: "Inspect contract" }] });
    expect(result.isError).not.toBe(true);
    expect(result.details?.phases).toEqual([{ name: "Execution", tasks: [] }]);
  });

  it("abandons a whole phase through the drop operation", async () => {
    const h = createHarness();
    todoContext(h.pi);
    await runTool(h, "todo_write", {
      ops: [{ op: "init", list: [{ phase: "Execution", items: ["Inspect contract", "Patch wrapper"] }] }],
    });

    const result = await runTool(h, "todo_write", { ops: [{ op: "drop", phase: "Execution" }] });

    expect(result.details?.phases).toEqual([
      {
        name: "Execution",
        tasks: [
          { content: "Inspect contract", status: "abandoned" },
          { content: "Patch wrapper", status: "abandoned" },
        ],
      },
    ]);
    expect(result.details?.activeTask).toBeUndefined();
  });

  it("requires an exact task id for /todo from-task", async () => {
    const h = createHarness(explicitTaskProject());
    todoContext(h.pi);

    await runCommand(h, "from-task");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("Task import requires an exact task id.");
    expect(widget).toContain("Usage: /todo from-task <task-id>");
    expect(h.entries).toHaveLength(0);
  });

  it("reports a missing task index for /todo from-task", async () => {
    const h = createHarness(tempRoot());
    todoContext(h.pi);

    await runCommand(h, "from-task T-136");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("todo from-task failed.");
    expect(widget).toContain("Task target T-136 cannot be resolved because .tasks/index.json is");
    expect(widget).toContain("missing or unsupported.");
    expect(h.entries).toHaveLength(0);
  });

  it("rejects completion-note input that is not exactly one task id", async () => {
    const root = explicitTaskProject();
    const h = createHarness(root);
    todoContext(h.pi);

    await runCommand(h, "completion-note");
    expect(h.widgets.get("todo")).toContain("Completion note requires one exact task id.");
    expect(h.widgets.get("todo")).toContain("Usage: /todo completion-note [--yes] <task-id>");

    await runCommand(h, "completion-note --yes T-136 T-137");
    expect(h.widgets.get("todo")).toContain("Usage: /todo completion-note --yes <task-id>");

    await runCommand(h, "completion-note T-136 T-137");
    expect(h.widgets.get("todo")).toContain("Usage: /todo completion-note [--yes] <task-id>");
  });

  it("writes the completion note for the prompt tier because Pi owns the approval", async () => {
    const root = explicitTaskProject();
    const h = createHarness(root);
    todoContext(h.pi);
    await runCommand(h, "append Execution inspect contract");

    await runCommand(h, "completion-note T-136");

    const artifactPath = path.join(
      root,
      ".tasks",
      "T-136-explicit-task-todo-bridge-command-surface",
      "artifacts",
      "completion-note.md",
    );
    expect(readFileSync(artifactPath, "utf8")).toContain("- [ ] Inspect contract");
    expect(h.widgets.get("todo")).toContain("Completion note written for task T-136.");
  });

  it("reports the offending line when editor Markdown has an unknown status marker", async () => {
    const h = createHarness();
    todoContext(h.pi);
    h.ctx.ui.editor = (async () => "# Review\n- [?] Inspect OMP todo command\n") as unknown as typeof h.ctx.ui.editor;

    await runCommand(h, "edit");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("Could not parse session todos; state was not changed.");
    expect(widget).toContain('unknown status marker "[?]"');
    expect(h.entries).toHaveLength(0);
  });

  it("keeps every documented verb in the /todo help body", async () => {
    const h = createHarness();
    todoContext(h.pi);

    await runCommand(h, "help");

    const widget = h.widgets.get("todo") ?? "";
    expect(widget).toContain("[VIEW] Session todos help");
    expect(widget).toContain("Inspect or explicitly change session-backed todo state.");
    expect(widget).toContain("/todos is a different surface: the Todos prompt shelf.");
  });
});
