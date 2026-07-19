import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLiveStore, type SdkAgentSessionEventLike } from "../../../extensions/_shared/agent-sdk-host.js";
import { createHarness, runTool } from "../../test-harness.js";

const tempRoots: string[] = [];

afterEach(() => {
  agentLiveStore.reset();
  vi.resetModules();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.doUnmock("../../../extensions/_shared/agent-runner.js");
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-pi-agent-task-tool-"));
  tempRoots.push(root);
  return root;
}

function mockSdkResult(text: string): void {
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    DefaultResourceLoader: class {
      constructor(_options: Record<string, unknown>) {}
      reload() {}
    },
    getAgentDir() {
      return tempRoot();
    },
    async createAgentSession() {
      let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
      return {
        session: {
          sessionId: "sdk-child",
          subscribe(fn: (event: SdkAgentSessionEventLike) => void) {
            listener = fn;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({ type: "turn_start" });
            listener?.({ type: "agent_end", willRetry: false });
          },
          getSessionStats() {
            return { sessionId: "sdk-child", toolCalls: 0, toolResults: 0 };
          },
          getLastAssistantText() {
            return text;
          },
          exportToJsonl(outputPath: string) {
            return outputPath;
          },
          dispose() {},
        },
      };
    },
  }));
}

describe("agent task tool execution", () => {
  it("returns one child's exact text and keeps metadata in details", async () => {
    mockSdkResult("  done\nwith details\n");
    const { default: agents } = await import("../../../extensions/agents/index.js");
    const h = createHarness(tempRoot(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" };
    h.pi.setThinkingLevel?.("high");
    agents(h.pi);

    const result = await runTool(h, "task", {
      task: "Return done",
      title: "Show model",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "  done\nwith details\n" }]);
    expect(result.details).toMatchObject({
      requestedSurface: "task",
      requestedAgent: "task",
      agent: "task",
      taskCount: 1,
      status: "completed",
      childSessionId: "sdk-child",
    });
    const row = [...agentLiveStore.rows.values()].at(-1);
    expect(row).toMatchObject({
      model: "openai/gpt-5.5",
      thinking: "high",
      status: "done",
      finalAnswer: "  done\nwith details\n",
    });
  });

  it("treats JSON-looking child output as ordinary text", async () => {
    const text = '{"status":"failed","summary":"model words only"}';
    mockSdkResult(text);
    const { default: agents } = await import("../../../extensions/agents/index.js");
    const h = createHarness(tempRoot(), { sessionId: "parent-session" });
    agents(h.pi);

    const result = await runTool(h, "spawn_agent", { task: "Return JSON-looking prose" });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(result.details).toMatchObject({ status: "completed", taskCount: 1 });
  });

  it("returns isError when the child has no non-empty final text", async () => {
    mockSdkResult(" \n ");
    const { default: agents } = await import("../../../extensions/agents/index.js");
    const h = createHarness(tempRoot(), { sessionId: "parent-session" });
    agents(h.pi);

    const result = await runTool(h, "task", { task: "Return nothing" });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Agent result text is empty." }]);
    expect(result.details).toMatchObject({ status: "failed", taskCount: 1 });
  });

  it("stops progress and surfaces an error when the run boundary throws", async () => {
    vi.doMock("../../../extensions/_shared/agent-runner.js", async () => {
      const actual = await vi.importActual<typeof import("../../../extensions/_shared/agent-runner.js")>(
        "../../../extensions/_shared/agent-runner.js",
      );
      return {
        ...actual,
        async executeAgentRunBoundary() {
          throw new Error("simulated host crash mid-run");
        },
      };
    });
    const { default: agents } = await import("../../../extensions/agents/index.js");
    const h = createHarness(tempRoot(), { sessionId: "parent-session" });
    h.ctx.hasUI = true;
    agents(h.pi);

    await expect(runTool(h, "spawn_agent", { task: "explode" })).rejects.toThrow("simulated host crash mid-run");

    const factory = h.widgetPayloads.get("agents");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: () => {}, terminal: { rows: 30, columns: 100 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => { render(width: number): string[] })(
      stubTui,
      {},
    );
    expect(component.render(100).some((line) => line.includes("error") || line.includes("FAILED"))).toBe(true);
  });
});
