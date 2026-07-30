import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plan from "../../../extensions/plan/index.js";
import type {
  ExtensionCommandContext,
  ReplacementSessionContext,
  ReplacementSessionEntryLike,
} from "../../../extensions/_shared/host/pi-api.js";
import { isInPlanMode, loadModeState, planArtifactPath } from "../../../extensions/plan/mode-state.js";
import { createHarness, runTool } from "../../test-harness.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = path.join(tmpdir(), `locus-pi-prompt-commands-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", pi: { extensions: [] } }, null, 2));
  tempRoots.push(root);
  return root;
}

function promptPath(root: string, name: string): string {
  return path.join(root, ".locus", "runtime", "prompts", `${name}.md`);
}

function goalStatePath(root: string): string {
  return path.join(root, ".locus", "runtime", "goal", "state.json");
}

function taskPromptPath(root: string, kind: string, taskDir = "T-1-prompt-contract"): string {
  return path.join(root, ".tasks", taskDir, "artifacts", `${kind}-prompt.md`);
}

function writeTaskIndex(root: string, task: { id?: string; title?: string; taskPath?: string } = {}): void {
  mkdirSync(path.join(root, ".tasks"), { recursive: true });
  writeFileSync(
    path.join(root, ".tasks", "index.json"),
    JSON.stringify(
      {
        schema: "index.v1",
        generated_at: "2026-06-10T00:00:00.000Z",
        tasks: [
          {
            id: task.id ?? "T-1",
            title: task.title ?? "Prompt contract",
            status: "doing",
            type: "feature",
            path: task.taskPath ?? "T-1-prompt-contract",
          },
        ],
      },
      null,
      2,
    ),
  );
}

function expectWidgetLinesToFit(widget: string, width = 80): void {
  for (const line of widget.split(/\r?\n/)) {
    expect(line.length, line).toBeLessThanOrEqual(width);
  }
}

async function withTempPiHome<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  const tmpHome = path.join(tmpdir(), `${prefix}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  tempRoots.push(tmpHome);
  const savedHome = process.env["LOCUS_PI_HOME"];
  process.env["LOCUS_PI_HOME"] = tmpHome;
  try {
    return await run();
  } finally {
    if (savedHome === undefined) delete process.env["LOCUS_PI_HOME"];
    else process.env["LOCUS_PI_HOME"] = savedHome;
  }
}

function stubPlanSession(
  h: ReturnType<typeof createHarness>,
  root: string,
  entries: ReplacementSessionEntryLike[],
): { commandCtx: ExtensionCommandContext; kickoff: () => string } {
  let kickoff = "";
  const commandCtx = h.ctx as ExtensionCommandContext;
  commandCtx.newSession = async (opts) => {
    const replacementCtx: ReplacementSessionContext = {
      ...h.ctx,
      session: { id: "plan-child", projectRoot: root, workingDirectory: root },
      async sendUserMessage(message) {
        kickoff = String(message);
      },
      async waitForIdle() {},
      sessionManager: {
        getEntries() {
          return entries;
        },
      },
    };
    await opts?.withSession?.(replacementCtx);
    return { cancelled: false };
  };
  return { commandCtx, kickoff: () => kickoff };
}

describe("default prompt commands", () => {
  it("/plan list shows only saved plans, no usage text", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "plan-list-session" });
    plan(h.pi);

    await h.commands.get("plan")!.handler("list", h.ctx);

    const widget = h.widgets.get("plan") ?? "";
    expect(widget).toContain("[VIEW] Saved plans");
    expect(widget).toContain("No saved plans.");
    expect(widget).not.toContain("Usage:");
    expect(h.widgetOptions.get("plan")?.placement).toBe("belowEditor");
  });

  it.each([["help"], ["?"]])("/plan %s shows full untruncated usage incl. saved plans", async (verb) => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: `plan-help-session-${verb}` });
    plan(h.pi);

    await h.commands.get("plan")!.handler(verb, h.ctx);

    const widget = h.widgets.get("plan") ?? "";
    expect(widget).toContain("[VIEW] Plan help");
    expect(widget).toContain("saved plans: 0");
    expect(widget).toContain("/plan <request>");
    expect(widget).toContain("/plan exit");
    expect(widget).toContain("/plan list");
    expect(widget).toContain("/plan open <slug>");
    expect(widget).toContain("/plan help");
    // routed through the host-EXEMPT factory path, not the capped string[] path.
    expect(typeof h.widgetPayloads.get("plan")).toBe("function");
    expect(widget).not.toContain("widget truncated");
  });

  it("/plan open uses typed warnings for missing and unknown slugs", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "plan-open-warning-session" });
    plan(h.pi);

    await h.commands.get("plan")!.handler("open", h.ctx);
    expect(h.widgets.get("plan")).toContain("[WARN] Plan open");
    expect(h.widgets.get("plan")).toContain("A saved-plan slug is required.");
    expect(h.widgetOptions.get("plan")).toEqual({ placement: "aboveEditor" });

    await h.commands.get("plan")!.handler("open missing-plan", h.ctx);
    expect(h.widgets.get("plan")).toContain("[WARN] Plan open");
    expect(h.widgets.get("plan")).toContain("Plan not found: missing-plan");
    expect(h.widgetOptions.get("plan")).toEqual({ placement: "aboveEditor" });
  });

  it("bare /plan on a headless host performs no UI or state mutation", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "plan-bare-headless-session" });
    h.ctx.hasUI = false;
    plan(h.pi);

    await h.commands.get("plan")!.handler("", h.ctx);

    expect(h.widgets.get("plan") ?? "").toBe("");
    expect(loadModeState(root)).toBeNull();
  });

  it("bare /plan on a UI host prompts for a request and enters plan mode directly", async () => {
    await withTempPiHome("plan-bare-ui-home", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-bare-ui-session" });
      const { commandCtx } = stubPlanSession(h, root, [
        { type: "message", role: "assistant", content: "## Goal\nShip it." },
      ]);
      commandCtx.hasUI = true;
      const input = vi.fn(async () => "typed");
      commandCtx.ui.input = input as never;

      plan(h.pi);
      await h.commands.get("plan")!.handler("", commandCtx);

      const state = loadModeState(root);
      expect(state).not.toBeNull();
      expect(state?.mode).toBe("plan");
      expect(state?.status).toBe("active");
      expect(state?.slug).toContain("typed");
      expect(input).toHaveBeenCalledWith(
        "[INPUT] Plan request — desired end state",
        "Describe the state the plan should make true",
      );
    });
  });

  it("bare /plan on a UI host falls back to a nudge when the prompt is cancelled", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "plan-bare-cancel-session" });
    plan(h.pi);
    h.ctx.hasUI = true;
    h.ctx.ui.input = async () => ({ value: "", cancelled: true });

    await h.commands.get("plan")!.handler("", h.ctx);

    expect(loadModeState(root)).toBeNull();
    expect(h.widgets.get("plan")).toContain("[RESULT]");
    expect(h.widgets.get("plan")).toContain("[CANCELLED]");
    expect(h.widgets.get("plan")).toContain("no state or artifact was changed");
  });

  it("bare /plan tolerates ctx.ui.input resolving to undefined (live host quirk on Escape)", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "plan-bare-undefined-input-session" });
    plan(h.pi);
    h.ctx.hasUI = true;
    h.ctx.ui.input = async () => undefined as never;

    await h.commands.get("plan")!.handler("", h.ctx);

    expect(loadModeState(root)).toBeNull();
    expect(h.widgets.get("plan")).toContain("[RESULT]");
    expect(h.widgets.get("plan")).toContain("[CANCELLED]");
  });

  it("bare /plan fails closed when the host returns an unsupported dialog result", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "plan-bare-dialog-error-session" });
    plan(h.pi);
    h.ctx.hasUI = true;
    h.ctx.ui.input = async () => ({ label: "not-a-dialog-result" }) as never;

    await expect(h.commands.get("plan")!.handler("", h.ctx)).resolves.toBeUndefined();

    expect(loadModeState(root)).toBeNull();
    expect(h.widgets.get("plan")).toContain("[ERROR]");
    expect(h.widgets.get("plan")).toContain("unsupported result");
  });

  it("opens a long saved plan via a clamped factory widget with no host truncation (T-175 B5)", async () => {
    await withTempPiHome("plan-open-b5", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-open-b5" });
      plan(h.pi);

      const slug = "long-plan-20260630-aaaa";
      const body = Array.from({ length: 40 }, (_, i) => `step ${i + 1}: do the thing number ${i + 1}`).join("\n");
      const artifactPath = planArtifactPath(root, slug);
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, `# Goal\n\n${body}\n`, "utf8");

      await h.commands.get("plan")!.handler(`open ${slug}`, h.ctx);

      // (a) routed through the host-EXEMPT factory path, not the capped string[] path.
      expect(typeof h.widgetPayloads.get("plan")).toBe("function");
      const widget = h.widgets.get("plan") ?? "";
      expect(widget).toContain("[CHANGE] Plan mode");
      expect(widget).toContain("behavioral plan mode is active");
      // (b) carries the "+N more — open <path>" affordance instead of dropping content.
      expect(widget).toContain("(+");
      expect(widget).toContain("more — open");
      // (c) never emits the host's 10-line cap marker.
      expect(widget).not.toContain("widget truncated");
      // (d) settled CHANGE follows the shared above-editor placement.
      expect(h.widgetOptions.get("plan")?.placement).toBe("aboveEditor");
      // (e) typed body is pre-clamped and remains inside the shared viewport budget.
      expect(widget.split(/\r?\n/).length).toBeLessThanOrEqual(18);
      // Each line is bounded to the render width in DISPLAY columns by
      // truncateToWidth (long paths get an ellipsis); raw .length can exceed the
      // width via ANSI reset codes, so display-width fit is what matters here.
    });
  });

  it.each([
    ["review", "Review the prompt commands for hidden state", "Review prompt saved."],
    ["todos", "Keep only explicit todo prompts", "Todos prompt saved."],
  ])("saves /%s prompt to the project-local fallback path", async (command, prompt, message) => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: `${command}-session` });
    plan(h.pi);

    await h.commands.get(command)!.handler(prompt, h.ctx);

    const filePath = promptPath(root, command);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain(prompt);
    expect(h.widgets.get(command)).toContain(message);
    expect(h.widgets.get(command)).toContain("target: project-local");
    expect(h.widgets.get(command)).toContain(`kind: ${command}`);
    expect(h.widgets.get(command)).toContain(`path: ./.locus/runtime/prompts/${command}.md`);
    expect(h.widgets.get(command)).not.toContain("://");
    expect(existsSync(path.join(root, ".tasks"))).toBe(false);
  });

  it("enters plan mode on /plan <request>", async () => {
    await withTempPiHome("plan-enter-home", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-enter-session" });
      const { commandCtx } = stubPlanSession(h, root, [
        { type: "message", role: "assistant", content: "## Goal\nShip it." },
      ]);
      plan(h.pi);

      await h.commands.get("plan")!.handler("Add a feature", commandCtx);

      const state = loadModeState(root);
      expect(state).not.toBeNull();
      expect(state?.mode).toBe("plan");
      expect(state?.status).toBe("active");
      const modeStatus = h.statuses.get("locus");
      expect(modeStatus).toBeDefined();
      expect(modeStatus).toBe("MODE plan");
      expect(h.statuses.has("mode")).toBe(false);
    });
  });

  it("exits plan mode on /plan exit", async () => {
    await withTempPiHome("plan-exit-home", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-exit-session" });
      const { commandCtx } = stubPlanSession(h, root, [
        { type: "message", role: "assistant", content: "## Goal\nShip it." },
      ]);
      plan(h.pi);

      // Enter first
      await h.commands.get("plan")!.handler("Add a feature", commandCtx);
      expect(h.statuses.get("locus")).toBe("MODE plan");

      // Exit
      await h.commands.get("plan")!.handler("exit", h.ctx);

      const state = loadModeState(root);
      expect(isInPlanMode(state)).toBe(false);
      expect(h.statuses.has("locus")).toBe(false);
    });
  });

  it("saves authored LLM output to a user-level plan artifact", async () => {
    await withTempPiHome("plan-authored-home", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-authored-parent" });
      const entries: ReplacementSessionEntryLike[] = [
        {
          type: "message",
          role: "assistant",
          content: "```markdown\n## Goal\nThis is the plan.\n\n## Approach\nEdit the plan command.\n```",
        },
      ];
      const { commandCtx, kickoff } = stubPlanSession(h, root, entries);
      plan(h.pi);

      await h.commands.get("plan")!.handler("Add read-only mode", commandCtx);

      const state = loadModeState(root);
      expect(kickoff()).toContain("User request:");
      expect(kickoff()).toContain("Add read-only mode");
      expect(state).not.toBeNull();
      expect(state?.status).toBe("active");
      const artifactPath = planArtifactPath(root, state?.slug ?? "");
      expect(state?.activeArtifactPath).toBe(artifactPath);
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = readFileSync(artifactPath, "utf8");
      expect(artifact).toContain("## Goal");
      expect(artifact).toContain("This is the plan.");
      expect(artifact).not.toContain("Add read-only mode");
      expect(h.statuses.get("locus")).toBe("MODE plan");
      expect(h.widgets.get("plan") ?? "").toContain("[RESULT]");
      expect(h.widgets.get("plan") ?? "").toContain("Plan saved");
      expect(h.widgets.get("plan") ?? "").toContain("path:");
    });
  });

  it("enters draft plan mode and saves a stub artifact when the draft session fails", async () => {
    await withTempPiHome("plan-failure-home", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-failure-parent" });
      const { commandCtx } = stubPlanSession(h, root, []);
      plan(h.pi);

      await h.commands.get("plan")!.handler("Add read-only mode", commandCtx);

      const state = loadModeState(root);
      expect(isInPlanMode(state)).toBe(true);
      expect(state?.status).toBe("draft");
      const artifactPath = planArtifactPath(root, state?.slug ?? "");
      expect(existsSync(artifactPath)).toBe(true);
      expect(readFileSync(artifactPath, "utf8")).toContain("Draft plan unavailable");
      expect(h.widgets.get("plan") ?? "").toContain("Replacement session did not return a valid Locus");
      expect(h.widgets.get("plan") ?? "").toContain("Prompt Draft.");
    });
  });

  it("blocks plan mode without a replacement-session host", async () => {
    await withTempPiHome("plan-blocked-home", async () => {
      const root = tempRoot();
      const h = createHarness(root, { sessionId: "plan-blocked-parent" });
      plan(h.pi);

      await h.commands.get("plan")!.handler("Add read-only mode", h.ctx);

      expect(h.widgets.get("plan") ?? "").toContain("[ERROR]");
      expect(h.widgets.get("plan") ?? "").toContain("Plan mode is blocked");
      expect(isInPlanMode(loadModeState(root))).toBe(false);
      expect(h.statuses.get("mode")).toBeFalsy();
    });
  });

  it("sets /goal objective and replaces active goal state", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-set-session" });
    plan(h.pi);

    await h.commands.get("goal")!.handler("ship stable local goal flow", h.ctx);
    const first = JSON.parse(readFileSync(goalStatePath(root), "utf8")) as {
      version: number;
      goal: { objective: string; status: string };
    };
    expect(first.version).toBe(1);
    expect(first.goal.objective).toBe("ship stable local goal flow");

    await h.commands.get("goal")!.handler("set improve the operator loop", h.ctx);
    const second = JSON.parse(readFileSync(goalStatePath(root), "utf8")) as {
      goal: { objective: string; status: string };
    };
    expect(second.goal.objective).toBe("improve the operator loop");
    expect(h.widgets.get("goal") ?? "").toContain("Goal created.");
    expect(h.widgets.get("goal") ?? "").toContain("objective: improve the operator loop");
    expect(readFileSync(goalStatePath(root), "utf8")).toContain("improve the operator loop");
  });

  it("supports /goal show, pause, resume, drop, complete, and budget", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-lifecycle-session" });
    plan(h.pi);

    await h.commands.get("goal")!.handler("ship a tiny local goal", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("status: active");

    await h.commands.get("goal")!.handler("show", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("status: active");

    await h.commands.get("goal")!.handler("pause", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal paused");

    await h.commands.get("goal")!.handler("resume", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal resumed");

    await h.commands.get("goal")!.handler("budget 24", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal budget set to 24 tokens.");

    await h.commands.get("goal")!.handler("budget off", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal budget cleared");

    await h.commands.get("goal")!.handler("complete", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal completed");
    expect(h.widgets.get("goal") ?? "").toContain("status: complete");

    const afterComplete = JSON.parse(readFileSync(goalStatePath(root), "utf8")) as { goal: { status: string } };
    expect(afterComplete.goal.status).toBe("complete");

    await h.commands.get("goal")!.handler("drop", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal dropped");

    const afterDrop = JSON.parse(readFileSync(goalStatePath(root), "utf8")) as { goal: { status: string } };
    expect(afterDrop.goal.status).toBe("dropped");
  });

  it("sets budget-limited when new budget is below current token usage", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-budget-limit-session" });
    plan(h.pi);

    await h.commands.get("goal")!.handler("ship a tracked goal", h.ctx);
    const statePath = goalStatePath(root);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      goal: {
        tokensUsed: number;
        status: string;
      };
    };
    state.goal.tokensUsed = 100;
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          version: 1,
          goal: {
            ...state.goal,
            status: "active",
          },
        },
        null,
        2,
      ) + "\n",
    );

    await h.commands.get("goal")!.handler("budget 10", h.ctx);
    expect(h.widgets.get("goal") ?? "").toContain("Goal budget set to 10 tokens.");

    const afterBudget = JSON.parse(readFileSync(statePath, "utf8")) as {
      goal: {
        status: string;
        tokensUsed: number;
      };
    };
    expect(afterBudget.goal.status).toBe("budget-limited");
    expect(afterBudget.goal.tokensUsed).toBe(100);
  });

  it("keeps /goal prompt task artifacts while making bare inspection summary-only", async () => {
    const root = tempRoot();
    writeTaskIndex(root);
    const h = createHarness(root, { sessionId: "goal-prompt-task-session" });
    plan(h.pi);

    await h.commands.get("goal")!.handler("prompt --task T-1 Explicit goal prompt path", h.ctx);

    const taskPath = taskPromptPath(root, "goal");
    const projectPath = promptPath(root, "goal");
    expect(existsSync(taskPath)).toBe(true);
    expect(readFileSync(taskPath, "utf8")).toContain("Explicit goal prompt path");
    expect(existsSync(projectPath)).toBe(false);
    expect(h.widgets.get("goal") ?? "").toContain("Goal prompt saved.");
    expect(h.widgets.get("goal") ?? "").toContain("path: .tasks/T-1/artifacts/goal-prompt.md");

    await h.commands.get("goal")!.handler("prompt --task T-1", h.ctx);
    const summaryWidget = h.widgets.get("goal") ?? "";
    expect(summaryWidget).toContain("[VIEW] Goal prompt shelf");
    expect(summaryWidget).toContain("Saved goal prompt.");
    expect(summaryWidget).toContain("body is hidden from this summary");
    expect(summaryWidget).toContain("path: .tasks/T-1/artifacts/goal-prompt.md");
    expect(summaryWidget).not.toContain("Explicit goal prompt path");

    await h.commands.get("goal")!.handler("prompt --task T-1 show", h.ctx);
    const bodyWidget = h.widgets.get("goal") ?? "";
    expect(bodyWidget).toContain("[VIEW] Goal prompt shelf body");
    expect(bodyWidget).toContain("Explicit goal prompt path");
  });

  it("supports explicit shelf body view and literal reserved verbs without inspection writes", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "review-shelf-contract" });
    plan(h.pi);

    await h.commands.get("review")!.handler("Legacy review body", h.ctx);
    const artifactPath = promptPath(root, "review");
    const saved = readFileSync(artifactPath, "utf8");

    await h.commands.get("review")!.handler("", h.ctx);
    expect(h.widgets.get("review")).toContain("[VIEW] Review prompt shelf");
    expect(h.widgets.get("review")).toContain("body is hidden from this summary");
    expect(h.widgets.get("review")).not.toContain("Legacy review body");
    expect(readFileSync(artifactPath, "utf8")).toBe(saved);

    await h.commands.get("review")!.handler("show", h.ctx);
    expect(h.widgets.get("review")).toContain("[VIEW] Review prompt shelf body");
    expect(h.widgets.get("review")).toContain("Legacy review body");
    expect(readFileSync(artifactPath, "utf8")).toBe(saved);

    await h.commands.get("review")!.handler("set show", h.ctx);
    expect(h.widgets.get("review")).toContain("[CHANGE] Review prompt shelf");
    expect(readFileSync(artifactPath, "utf8")).toContain("\nshow\n");

    const literalSaved = readFileSync(artifactPath, "utf8");
    await h.commands.get("review")!.handler("set", h.ctx);
    expect(h.widgets.get("review")).toContain("[WARN] Review prompt shelf");
    expect(h.widgets.get("review")).toContain("set requires a non-empty prompt");
    expect(readFileSync(artifactPath, "utf8")).toBe(literalSaved);
  });

  it("places dynamic empty goal and shelf warnings above the editor", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "empty-state-placement" });
    plan(h.pi);

    for (const [command, args, label] of [
      ["goal", "", "[WARN] Goal state"],
      ["review", "", "[WARN] Review prompt shelf"],
      ["todos", "", "[WARN] Todos prompt shelf"],
      ["goal", "prompt", "[WARN] Goal prompt shelf"],
    ] as const) {
      await h.commands.get(command)!.handler(args, h.ctx);
      expect(h.widgets.get(command === "goal" ? "goal" : command)).toContain(label);
      expect(h.widgetOptions.get(command === "goal" ? "goal" : command)).toEqual({ placement: "aboveEditor" });
    }
  });

  it("keeps RPC/plain goal state and shelf body projections under the host line cap", async () => {
    const root = tempRoot();
    const h = createHarness(root, { mode: "rpc", sessionId: "plan-rpc-compact" });
    h.ctx.hasUI = true;
    plan(h.pi);

    await h.commands.get("goal")!.handler("Keep RPC goal state legible", h.ctx);
    await h.commands.get("goal")!.handler("show", h.ctx);
    const goalPayload = h.widgetPayloads.get("goal");
    expect(Array.isArray(goalPayload)).toBe(true);
    expect((goalPayload as string[]).length).toBeLessThanOrEqual(10);
    expect(h.widgets.get("goal")).toContain("[VIEW] Goal state");
    expect(h.widgets.get("goal")).toContain("storage: .locus/runtime/goal/state.json");
    expect(h.widgets.get("goal")).not.toContain("widget truncated");

    await h.commands.get("review")!.handler("Line one\nLine two\nLine three\nLine four", h.ctx);
    await h.commands.get("review")!.handler("show", h.ctx);
    const shelfPayload = h.widgetPayloads.get("review");
    expect(Array.isArray(shelfPayload)).toBe(true);
    expect((shelfPayload as string[]).length).toBeLessThanOrEqual(10);
    const shelfWidget = h.widgets.get("review") ?? "";
    expect(shelfWidget).toContain("[VIEW] Review prompt shelf body");
    expect(shelfWidget).toContain("Line one");
    expect(shelfWidget).toContain("hidden;");
    expect(shelfWidget).toContain("path: ./.locus/runtime/prompts/review.md");
    expect(shelfWidget).not.toContain("widget truncated");
  });

  it.each([
    {
      command: "review",
      kind: "review",
      widgetKey: "review",
      saveArgs: "--task T-145 Review path wrapping.",
      showArgs: "--task T-145",
    },
    {
      command: "todos",
      kind: "todos",
      widgetKey: "todos",
      saveArgs: "--task T-145 Track path wrapping.",
      showArgs: "--task T-145",
    },
    {
      command: "goal",
      kind: "goal",
      widgetKey: "goal",
      saveArgs: "prompt --task T-145 Goal path wrapping.",
      showArgs: "prompt --task T-145",
    },
  ] as const)(
    "keeps task-backed /$command widgets bounded at 80 columns",
    async ({ command, kind, widgetKey, saveArgs, showArgs }) => {
      const root = tempRoot();
      const longTaskDir = "T-145-2026-06-18-tui-standard-and-tmux-proof-repair-loop-";
      writeTaskIndex(root, { id: "T-145", title: "TUI proof repair", taskPath: longTaskDir });
      const h = createHarness(root, { sessionId: `${command}-task-path-widget-session` });
      plan(h.pi);

      await h.commands.get(command)!.handler(saveArgs, h.ctx);

      expect(existsSync(taskPromptPath(root, kind, longTaskDir))).toBe(true);
      const saveWidget = h.widgets.get(widgetKey) ?? "";
      expect(saveWidget).toContain(`path: .tasks/T-145/artifacts/${kind}-prompt.md`);
      expect(saveWidget).toContain(`${command === "goal" ? "/goal prompt" : `/${command}`} --task T-145`);
      expect(saveWidget).not.toContain(longTaskDir);
      expectWidgetLinesToFit(saveWidget);

      await h.commands.get(command)!.handler(showArgs, h.ctx);

      const displayWidget = h.widgets.get(widgetKey) ?? "";
      expect(displayWidget).toContain(`Saved ${kind} prompt.`);
      expect(displayWidget).toContain(`path: .tasks/T-145/artifacts/${kind}-prompt.md`);
      expect(displayWidget).toContain(`${command === "goal" ? "/goal prompt" : `/${command}`} --task T-145`);
      expect(displayWidget).not.toContain(longTaskDir);
      expectWidgetLinesToFit(displayWidget);
    },
  );

  it("does not fall back to project-local storage when explicit task target is missing", async () => {
    const root = tempRoot();
    writeTaskIndex(root);
    const h = createHarness(root, { sessionId: "missing-task-session" });
    plan(h.pi);

    await h.commands.get("goal")!.handler("prompt --task T-404 Review the new contract", h.ctx);

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("goal prompt not saved.");
    expect(widget).toContain("target: task:T-404");
    expect(widget).toContain("Task target T-404 was not found in .tasks/index.json.");
    expect(widget).toContain("No project-local fallback was used");
    expect(existsSync(promptPath(root, "goal"))).toBe(false);
  });

  it("shows the stored goal state when /goal is invoked without arguments", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-show-session" });
    plan(h.pi);

    await h.commands.get("goal")!.handler("Build operator-friendly local goal mode", h.ctx);
    writeFileSync(
      goalStatePath(root),
      `${JSON.stringify(
        {
          version: 1,
          goal: {
            id: "goal-view-proof",
            objective: "Build operator-friendly local goal mode",
            status: "active",
            tokenBudget: 2400,
            tokensUsed: 1200,
            timeUsedSeconds: 75,
            createdAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-09T10:01:15.000Z",
            activeSince: "2026-07-09T10:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
    );
    await h.commands.get("goal")!.handler("", h.ctx);

    const bareWidget = h.widgets.get("goal") ?? "";
    expect(bareWidget).toContain("[VIEW]");
    expect(bareWidget).toContain("Goal");
    expect(bareWidget).toContain("Build operator-friendly local goal mode");
    expect(bareWidget).toContain("id: goal-view-proof");
    expect(bareWidget).toContain("status: active");
    expect(bareWidget).toContain("usage: 1200 / 2400 tokens");
    expect(bareWidget).toContain("timeUsedSeconds: 75");
    expect(bareWidget).toContain("createdAt: 2026-07-09T10:00:00.000Z");
    expect(bareWidget).toContain("updatedAt: 2026-07-09T10:01:15.000Z");
    expect(bareWidget).toContain("activeSince: 2026-07-09T10:00:00.000Z");
    expect(bareWidget).toContain("storage: .locus/runtime/goal/state.json");
    expect(bareWidget).toContain("Transitions: /goal help");
    expect(typeof h.widgetPayloads.get("goal")).toBe("function");
    expect(h.widgetOptions.get("goal")?.placement).toBe("belowEditor");

    await h.commands.get("goal")!.handler("show", h.ctx);

    const showWidget = h.widgets.get("goal") ?? "";
    expect(showWidget).toBe(bareWidget);
    expect(typeof h.widgetPayloads.get("goal")).toBe("function");
    expect(h.widgetOptions.get("goal")?.placement).toBe("belowEditor");
  });

  it("keeps /goal continue as artifact metadata instead of showing the full prompt body", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-continue-screen-session" });
    plan(h.pi);

    await h.commands
      .get("goal")!
      .handler(
        "Build a unified command UI lifecycle that remains intentionally long enough to require screen-safe metadata",
        h.ctx,
      );
    await h.commands.get("goal")!.handler("continue summarize the current state\nwrite the next bounded patch", h.ctx);

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("Goal continuation saved.");
    expect(widget).toContain("Prompt body is stored in the artifact and omitted from this receipt.");
    expect(widget).not.toContain("Task:");
    expect(widget).not.toContain("Draft goal:");
    expect(widget).not.toContain("Final result:");
    expectWidgetLinesToFit(widget);

    const artifact = JSON.parse(
      readFileSync(path.join(root, ".locus", "runtime", "goal", "continue.md"), "utf8"),
    ) as Record<string, unknown>;
    expect(String(artifact.prompt ?? "")).toContain("Task:");
    expect(String(artifact.prompt ?? "")).toContain("Final result:");
  });

  it("blocks /goal-ai without a replacement-session host", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-ai-blocked-session" });
    plan(h.pi);

    await h.commands.get("goal-ai")!.handler("make this request sharper", h.ctx);

    const widget = h.widgets.get("goal") ?? "";
    expect(widget).toContain("[ERROR]");
    expect(widget).toContain("Draft blocked:");
    expect(widget).toContain("Replacement-session host is unavailable.");
    expect(widget).toContain("artifact: not written");
    expect(existsSync(promptPath(root, "goal"))).toBe(false);
  });

  it("uses a replacement-session LLM draft and saves it as a project-local goal prompt", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-ai-parent" });
    const generated = [
      "Task:",
      "Make goal commands useful",
      "",
      "Draft goal:",
      "The goal command surface turns rough intent into a usable prompt and stores it clearly.",
      "",
      "Intent:",
      "Clarify the operator workflow.",
      "",
      "Final result:",
      "A saved goal prompt is ready for later execution.",
    ].join("\n");
    const entries: ReplacementSessionEntryLike[] = [{ type: "message", role: "assistant", content: generated }];
    let kickoff = "";
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "goal-ai-child", projectRoot: root, workingDirectory: root },
        async sendUserMessage(message) {
          kickoff = String(message);
        },
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return entries;
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };
    plan(h.pi);

    await h.commands.get("goal-ai")!.handler("make goal commands useful", commandCtx);

    const filePath = promptPath(root, "goal");
    expect(kickoff).toContain("Locus Prompt Draft");
    expect(kickoff).toContain("User request:");
    expect(kickoff).toContain("make goal commands useful");
    expect(readFileSync(filePath, "utf8")).toContain("Draft goal:");
    expect(readFileSync(filePath, "utf8")).toContain(
      "The goal command surface turns rough intent into a usable prompt and stores it clearly.",
    );
    expect(h.widgets.get("goal")).toContain("[RESULT]");
    expect(h.widgets.get("goal")).toContain("Draft saved as a goal prompt; it was not executed.");
    expect(h.widgets.get("goal")).toContain("target: project-local");
    expect(h.widgets.get("goal")).toContain("kind: goal");
    expect(h.widgets.get("goal")).toContain("path: ./.locus/runtime/prompts/goal.md");
    expect(h.widgets.get("goal")).toContain("childSessionId: goal-ai-child");
  });

  it("bare /goal-ai uses the official editor signature and runs one draft session", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-ai-bare-parent" });
    h.ctx.hasUI = true;
    const editor = vi.fn(async () => "turn rough intent into a goal prompt");
    h.ctx.ui.editor = editor as never;
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
    let childRuns = 0;
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      childRuns += 1;
      await opts?.withSession?.({
        ...h.ctx,
        session: { id: "goal-ai-bare-child", projectRoot: root, workingDirectory: root },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{ type: "message", role: "assistant", content: generated }];
          },
        },
      });
      return { cancelled: false };
    };
    plan(h.pi);

    await h.commands.get("goal-ai")!.handler("", commandCtx);

    expect(editor).toHaveBeenCalledWith("[INPUT] Goal AI request — describe prompt outcome", "");
    expect(childRuns).toBe(1);
    expect(readFileSync(promptPath(root, "goal"), "utf8")).toContain("Draft goal:");
    expect(h.widgets.get("goal")).toContain("[RESULT]");
    expect(h.sentMessages).toEqual([]);
    expect(h.sentUserMessages).toEqual([]);
  });

  it("bare /goal-ai cancel and no-UI paths do not start a child or write a prompt", async () => {
    const cancelledRoot = tempRoot();
    const cancelled = createHarness(cancelledRoot, { sessionId: "goal-ai-bare-cancel" });
    cancelled.ctx.hasUI = true;
    cancelled.ctx.ui.editor = async () => undefined as never;
    const cancelledChild = vi.fn();
    cancelled.ctx.newSession = cancelledChild as never;
    plan(cancelled.pi);

    await cancelled.commands.get("goal-ai")!.handler("", cancelled.ctx);

    expect(cancelledChild).not.toHaveBeenCalled();
    expect(existsSync(promptPath(cancelledRoot, "goal"))).toBe(false);
    expect(cancelled.widgets.get("goal")).toContain("[CANCELLED]");

    const headlessRoot = tempRoot();
    const headless = createHarness(headlessRoot, { sessionId: "goal-ai-bare-headless", mode: "print" });
    headless.ctx.hasUI = false;
    const headlessEditor = vi.fn();
    const headlessChild = vi.fn();
    headless.ctx.ui.editor = headlessEditor as never;
    headless.ctx.newSession = headlessChild as never;
    plan(headless.pi);

    await headless.commands.get("goal-ai")!.handler("", headless.ctx);

    expect(headlessEditor).not.toHaveBeenCalled();
    expect(headlessChild).not.toHaveBeenCalled();
    expect(existsSync(promptPath(headlessRoot, "goal"))).toBe(false);
    expect(headless.widgets.get("goal") ?? "").toBe("");
  });

  it("bare /goal-ai fails closed when the host returns an unsupported dialog result", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-ai-dialog-error" });
    h.ctx.hasUI = true;
    h.ctx.ui.editor = async () => ({ label: "not-a-dialog-result" }) as never;
    const child = vi.fn();
    h.ctx.newSession = child as never;
    plan(h.pi);

    await expect(h.commands.get("goal-ai")!.handler("", h.ctx)).resolves.toBeUndefined();

    expect(child).not.toHaveBeenCalled();
    expect(existsSync(promptPath(root, "goal"))).toBe(false);
    expect(h.widgets.get("goal")).toContain("[ERROR]");
    expect(h.widgets.get("goal")).toContain("unsupported result");
  });

  it("does not save /goal-ai output that is not a Locus Prompt Draft", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-ai-invalid-parent" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "goal-ai-invalid-child", projectRoot: root, workingDirectory: root },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{ type: "message", role: "assistant", content: "Looks good to me." }];
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };
    plan(h.pi);

    await h.commands.get("goal-ai")!.handler("make goal commands useful", commandCtx);

    expect(h.widgets.get("goal")).toContain("[ERROR]");
    expect(h.widgets.get("goal")).toContain("Draft failed:");
    expect(h.widgets.get("goal")).toContain("Replacement session did not return a valid Locus Prompt Draft.");
    expect(existsSync(promptPath(root, "goal"))).toBe(false);
  });

  it("registers a model-callable goal tool and supports create/get transitions", async () => {
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "goal-tool-session" });
    plan(h.pi);

    const create = await runTool(h, "goal", { op: "create", objective: "Tool objective" });
    expect(create.isError ?? false).toBe(false);
    expect(create.details?.path).toBe(`${path.join(root, ".locus", "runtime", "goal", "state.json")}`);

    const result = await runTool(h, "goal", { op: "get" });
    const text = result.content?.map((item) => (item.type === "text" ? item.text : "")).join(" ");
    expect(result.isError ?? false).toBe(false);
    expect(text).toContain("Tool objective");
    expect(result.details?.path).toBe(`${path.join(root, ".locus", "runtime", "goal", "state.json")}`);
  });
});
