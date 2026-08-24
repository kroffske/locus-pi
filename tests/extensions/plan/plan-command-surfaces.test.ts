import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalOperationResult } from "../../../extensions/_shared/project/goal-mode.js";
import { isInPlanMode, loadModeState, writeModeState } from "../../../extensions/plan/mode-state.js";
import { goalOperationBlock } from "../../../extensions/plan/goal-operator-ui.js";
import { registerPlan } from "../../../extensions/plan/index.js";
import { createHarness, emit, runTool } from "../../test-harness.js";

/**
 * Characterization tests for the /plan, /mode, /goal, goal-tool and
 * before_agent_start zones that plan-behavioral-mode.test.ts and
 * plan-prompt-commands.test.ts leave uncovered. Written against the
 * pre-split entrypoint so the T-126 relayout has evidence it preserved
 * behavior; every expectation below records what the code does today.
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = path.join(tmpdir(), `locus-pi-plan-surfaces-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function goalStatePath(root: string): string {
  return path.join(root, ".locus", "runtime", "goal", "state.json");
}

function promptPath(root: string, name: string): string {
  return path.join(root, ".locus", "runtime", "prompts", `${name}.md`);
}

function writeGoalStateFile(root: string, overrides: Record<string, unknown> = {}): void {
  const filePath = goalStatePath(root);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        goal: {
          id: "goal-injection-proof",
          objective: "Keep the operator loop honest",
          status: "active",
          tokensUsed: 12,
          timeUsedSeconds: 34,
          createdAt: "2026-07-09T10:00:00.000Z",
          updatedAt: "2026-07-09T10:01:00.000Z",
          activeSince: "2026-07-09T10:00:00.000Z",
          ...overrides,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeTaskIndex(root: string): void {
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  writeFileSync(
    path.join(root, ".tasks", "index.json"),
    JSON.stringify(
      {
        schema: "index.v1",
        generated_at: "2026-06-10T00:00:00.000Z",
        tasks: [{ id: "T-1", title: "Prompt contract", status: "doing", type: "feature", path: "T-1-prompt-contract" }],
      },
      null,
      2,
    ),
  );
}

function armPlanMode(root: string, slug = "active-plan"): void {
  writeModeState(root, {
    version: 1,
    mode: "plan",
    slug,
    activeArtifactPath: path.join(root, "plans", `${slug}.md`),
    enteredAt: new Date().toISOString(),
    status: "active",
  });
}

describe("/plan replace confirmation", () => {
  it("keeps the active plan and starts no draft session when the replace confirm is declined", async () => {
    const root = tempRoot();
    armPlanMode(root, "first-plan");
    const h = createHarness(root, { sessionId: "plan-replace-declined" });
    registerPlan(h.pi);
    h.confirmQueue.push(false);

    await h.commands.get("plan")!.handler("Another request entirely", h.ctx);

    expect(h.confirmCalls).toHaveLength(1);
    expect(h.confirmCalls[0]!.title).toBe("Replace active plan 'first-plan'?");
    const widget = h.widgets.get("plan") ?? "";
    expect(widget).toContain("[RESULT]");
    expect(widget).toContain("Kept active plan 'first-plan'; no replacement was started.");
    expect(widget).toContain("[CANCELLED]");
    expect(widget).toContain("Exit first: /plan exit");
    // The active plan survives untouched.
    expect(isInPlanMode(loadModeState(root))).toBe(true);
    expect(loadModeState(root)?.slug).toBe("first-plan");
  });

  it("proceeds into the draft session when the replace confirm is accepted", async () => {
    const root = tempRoot();
    armPlanMode(root, "first-plan");
    const h = createHarness(root, { sessionId: "plan-replace-accepted" });
    registerPlan(h.pi);
    h.confirmQueue.push(true);

    await h.commands.get("plan")!.handler("Another request entirely", h.ctx);

    expect(h.confirmCalls).toHaveLength(1);
    // No replacement-session host in the harness: the draft is blocked, and the
    // blocked path leaves the previous mode state in place.
    const widget = h.widgets.get("plan") ?? "";
    expect(widget).toContain("[ERROR]");
    expect(widget).toContain("Plan mode is blocked");
    expect(loadModeState(root)?.slug).toBe("first-plan");
  });
});

describe("/mode unknown verb", () => {
  it("warns without changing the mode", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "mode-unknown" });
    registerPlan(h.pi);

    await h.commands.get("mode")!.handler("Turbo", h.ctx);

    const widget = h.widgets.get("plan") ?? "";
    expect(widget).toContain("[WARN] Behavioral mode");
    expect(widget).toContain("Unknown mode 'turbo'.");
    expect(widget).toContain("Supported: default, plan");
    expect(widget).toContain("Show current mode: /mode show");
    expect(h.widgetOptions.get("plan")).toEqual({ placement: "aboveEditor" });
    expect(loadModeState(root)).toBeNull();
  });
});

describe("/goal help and budget parsing", () => {
  it.each([["help"], ["?"]])("/goal %s renders the goal usage block below the editor", async (verb) => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: `goal-help-${verb}` });
    registerPlan(h.pi);

    await h.commands.get("goal")!.handler(verb, h.ctx);

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("[VIEW] Goal state help");
    expect(widget).toContain("Inspect or explicitly change the long-lived project goal.");
    expect(widget).toContain("/goal <objective>");
    expect(widget).toContain("/goal budget <N|off>");
    expect(widget).toContain("/goal prompt set <text>");
    expect(widget).toContain("/goal prompt <text>");
    expect(widget).toContain("Legacy-compatible write; prefer set.");
    expect(widget).toContain("/goal prompt is a different surface: the Goal prompt shelf.");
    expect(h.widgetOptions.get("goal")).toEqual({ placement: "belowEditor" });
  });

  it.each([["bogus"], ["0"], ["-3"], ["12.5"]])(
    "/goal budget %s is rejected and leaves the state untouched",
    async (value) => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: `goal-budget-${value}` });
      registerPlan(h.pi);

      await h.commands.get("goal")!.handler("ship a tracked goal", h.ctx);
      const before = readFileSync(goalStatePath(root), "utf8");

      await h.commands.get("goal")!.handler(`budget ${value}`, h.ctx);

      const widget = h.widgets.get("goal") ?? "";
      expect(widget).toContain("[WARN] Goal state");
      expect(widget).toContain("Invalid token budget; state was not changed.");
      expect(widget).toContain("Usage: /goal budget <N|off>");
      expect(readFileSync(goalStatePath(root), "utf8")).toBe(before);
    },
  );
});

/**
 * The `/goal` registration wraps its handler in the extension's only command
 * error boundary. `tests/extensions/plan/goal-operator-ui.test.ts` covers the
 * block builder in isolation, but nothing pinned the boundary itself, so it is
 * characterized here before the dispatch zone moves out of the entrypoint.
 */
describe("/goal command error boundary", () => {
  it("renders the goal error block when the command body throws and claims no state change", async () => {
    const root = tempRoot();
    // A file where the goal state directory belongs makes the state write throw.
    mkdirSync(path.join(root, ".locus", "runtime"), { recursive: true });
    writeFileSync(path.join(root, ".locus", "runtime", "goal"), "not a directory", "utf8");
    const h = createHarness(root, { sessionId: "goal-error-boundary" });
    registerPlan(h.pi);

    await expect(h.commands.get("goal")!.handler("Ship a goal that cannot be written", h.ctx)).resolves.toBeUndefined();

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("[ERROR] Goal state");
    expect(widget).toContain("Goal command failed; no successful state change is claimed.");
    expect(widget).toContain("error: ");
    expect(widget).toContain("Inspect current state: /goal");
    expect(widget).toContain("Help: /goal help");
    // The boundary passes no explicit placement, so the shared widget default applies.
    expect(h.widgetOptions.get("goal")).toEqual({ placement: "aboveEditor" });
  });
});

describe("goal tool transitions", () => {
  it("declares read approval only for op=get", () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-tool-approval" });
    registerPlan(h.pi);

    const approval = h.tools.get("goal")!.approval as (args: unknown) => string;
    expect(typeof approval).toBe("function");
    expect(approval({ op: "get" })).toBe("read");
    expect(approval({ op: "create" })).toBe("write");
    expect(approval({ op: "complete" })).toBe("write");
    expect(approval(undefined)).toBe("write");
  });

  it("errors on op=get with no state and on op=create with no objective", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-tool-errors" });
    registerPlan(h.pi);

    const missing = await runTool(h, "goal", { op: "get" });
    expect(missing.isError).toBe(true);
    expect(missing.content?.map((item) => (item.type === "text" ? item.text : "")).join(" ")).toContain(
      "No active goal state.",
    );

    const noObjective = await runTool(h, "goal", { op: "create", objective: "   " });
    expect(noObjective.isError).toBe(true);
    expect(noObjective.content?.map((item) => (item.type === "text" ? item.text : "")).join(" ")).toContain(
      "Goal create requires objective.",
    );
    expect(existsSync(goalStatePath(root))).toBe(false);
  });

  it("rejects params that fail schema validation", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-tool-invalid" });
    registerPlan(h.pi);

    const invalid = await runTool(h, "goal", { op: "nope" });
    expect(invalid.isError).toBe(true);
  });

  it("reports complete, resume and drop transitions with the state path in details", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-tool-transitions" });
    registerPlan(h.pi);

    await runTool(h, "goal", { op: "create", objective: "Tool transition objective", token_budget: 500 });

    const completed = await runTool(h, "goal", { op: "complete" });
    expect(completed.isError ?? false).toBe(false);
    expect(completed.content?.map((item) => (item.type === "text" ? item.text : "")).join(" ")).toContain(
      "Goal completed: Tool transition objective",
    );
    expect((completed.details?.goal as { status?: string } | undefined)?.status).toBe("complete");
    expect(completed.details?.path).toBe(goalStatePath(root));
    expect(completed.details?.completionAuditPath).toBe(
      path.join(root, ".locus", "runtime", "goal", "completion-audit.json"),
    );

    // A completed goal is not resumable: the transition reports the current
    // status instead of reactivating it.
    const resumed = await runTool(h, "goal", { op: "resume" });
    expect(resumed.isError ?? false).toBe(false);
    expect(resumed.content?.map((item) => (item.type === "text" ? item.text : "")).join(" ")).toContain(
      "Goal is complete.",
    );
    expect((resumed.details?.goal as { status?: string } | undefined)?.status).toBe("complete");

    const dropped = await runTool(h, "goal", { op: "drop" });
    expect((dropped.details?.goal as { status?: string } | undefined)?.status).toBe("dropped");
    expect(dropped.details?.completionAuditPath).toBeUndefined();
  });

  it("surfaces a transition error with the current goal still in details", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-tool-transition-error" });
    registerPlan(h.pi);

    const noState = await runTool(h, "goal", { op: "complete" });
    expect(noState.isError).toBe(true);
    expect(noState.content?.map((item) => (item.type === "text" ? item.text : "")).join(" ")).toContain(
      "No active goal state.",
    );
    expect(noState.details?.path).toBe(goalStatePath(root));
  });
});

describe("before_agent_start context injection", () => {
  it("injects the goal context for an active goal", async () => {
    const root = tempRoot();
    writeGoalStateFile(root);
    const h = createHarness(root, { sessionId: "goal-injection" });
    registerPlan(h.pi);

    const [result] = await emit(h, "before_agent_start", { systemPrompt: "BASE PROMPT" });

    expect(result?.systemPrompt).toContain("BASE PROMPT");
    expect(result?.systemPrompt).toContain("<goal_context>");
    expect(result?.systemPrompt).toContain("objective=Keep the operator loop honest");
    expect(result?.systemPrompt).toContain("id=goal-injection-proof");
  });

  it.each([["complete"], ["dropped"]])("does not inject the goal context when the goal is %s", async (status) => {
    const root = tempRoot();
    writeGoalStateFile(root, { status });
    const h = createHarness(root, { sessionId: `goal-injection-${status}` });
    registerPlan(h.pi);

    const results = await emit(h, "before_agent_start", { systemPrompt: "BASE PROMPT" });

    expect(results.every((entry) => entry === undefined || entry.systemPrompt === undefined)).toBe(true);
  });

  it("uses the injected block as the whole prompt when the host prompt is empty", async () => {
    const root = tempRoot();
    writeGoalStateFile(root);
    const h = createHarness(root, { sessionId: "goal-injection-empty-base" });
    registerPlan(h.pi);

    const [result] = await emit(h, "before_agent_start", { systemPrompt: "" });

    expect(result?.systemPrompt?.startsWith("<goal_context>")).toBe(true);
  });

  it("orders the goal context before the plan framing when both are active", async () => {
    const root = tempRoot();
    writeGoalStateFile(root);
    armPlanMode(root);
    const h = createHarness(root, { sessionId: "goal-and-plan-injection" });
    registerPlan(h.pi);

    const [result] = await emit(h, "before_agent_start", { systemPrompt: "BASE PROMPT" });

    const prompt = result?.systemPrompt ?? "";
    expect(prompt.indexOf("<goal_context>")).toBeGreaterThan(prompt.indexOf("BASE PROMPT"));
    expect(prompt.indexOf("<planning_mode>")).toBeGreaterThan(prompt.indexOf("<goal_context>"));
  });
});

describe("/goal-ai target resolution", () => {
  it("refuses an unknown explicit task target without writing an artifact", async () => {
    const root = tempRoot();
    writeTaskIndex(root);
    const h = createHarness(root, { sessionId: "goal-ai-unknown-task" });
    registerPlan(h.pi);

    await h.commands.get("goal-ai")!.handler("--task T-404 sharpen this request", h.ctx);

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("[ERROR] Goal AI target");
    expect(widget).toContain("Task target T-404 was not found in .tasks/index.json.");
    expect(widget).toContain("target: task:T-404");
    expect(widget).toContain("artifact: not written");
    expect(existsSync(promptPath(root, "goal"))).toBe(false);
  });

  it("compacts the task artifact path in the saved-draft receipt", async () => {
    const root = tempRoot();
    writeTaskIndex(root);
    const h = createHarness(root, { sessionId: "goal-ai-task-path" });
    const generated = [
      "Task:",
      "Draft a goal prompt",
      "",
      "Draft goal:",
      "A saved prompt captures the requested outcome.",
      "",
      "Final result:",
      "The goal prompt is ready for explicit continuation.",
    ].join("\n");
    h.ctx.newSession = (async (opts?: { withSession?: (c: unknown) => Promise<void> }) => {
      await opts?.withSession?.({
        ...h.ctx,
        session: { id: "goal-ai-task-child", projectRoot: root, workingDirectory: root },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{ type: "message", role: "assistant", content: generated }];
          },
        },
      });
      return { cancelled: false };
    }) as never;
    registerPlan(h.pi);

    await h.commands.get("goal-ai")!.handler("--task=T-1 sharpen this request", h.ctx);

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("[RESULT]");
    expect(widget).toContain("target: task:T-1");
    expect(widget).toContain("path: .tasks/T-1/artifacts/goal-prompt.md");
    expect(existsSync(path.join(root, ".tasks", "T-1-prompt-contract", "artifacts", "goal-prompt.md"))).toBe(true);
  });
});

/**
 * Characterization of the project-relative path formatter used by the goal
 * continuation receipt. tests/extensions/plan/goal-operator-ui.test.ts only
 * covers the inside-the-root branch; the outside-the-root fallback had no test,
 * so both branches are pinned here before the formatter is deduplicated onto
 * the identical _shared/project/prompt-command-store.ts helper.
 */
describe("goal continuation path formatting", () => {
  function continuationResult(filePath: string): GoalOperationResult {
    return {
      state: null,
      changed: false,
      message: "Goal continuation saved.",
      continuation: {
        version: 1,
        goalId: "goal-1",
        objective: "Keep the receipt path readable",
        path: filePath,
        prompt: "SECRET CONTINUATION BODY",
        autoDispatch: false,
        status: "manual",
        stopReason: "bounded",
        createdAt: "2026-07-27T00:00:00.000Z",
        maxSteps: 1,
      },
    };
  }

  it("renders a path inside the project root as a ./-prefixed relative path", () => {
    const filePath = path.join("/repo", ".locus", "runtime", "goal", "continue.md");
    const block = goalOperationBlock(continuationResult(filePath), "/repo");
    expect(block.metadata).toContain("path: ./.locus/runtime/goal/continue.md");
  });

  it("keeps a path outside the project root absolute", () => {
    const filePath = path.join("/elsewhere", "goal", "continue.md");
    const block = goalOperationBlock(continuationResult(filePath), "/repo");
    expect(block.metadata).toContain(`path: ${filePath}`);
  });
});
