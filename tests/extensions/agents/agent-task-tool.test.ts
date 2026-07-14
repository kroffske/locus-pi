import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RESULT_MARKER } from "../../../extensions/_shared/agent-executor-host.js";
import { agentLiveStore, type SdkAgentSessionEventLike } from "../../../extensions/_shared/agent-sdk-host.js";
import { createHarness, runTool } from "../../test-harness.js";

const tempRoots: string[] = [];

afterEach(() => {
  agentLiveStore.reset();
  vi.resetModules();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-pi-agent-task-tool-"));
  tempRoots.push(root);
  return root;
}

describe("agent task tool execution UX", () => {
  it("renders the current runtime model and /effort in the live task row", async () => {
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
            sessionId: "sdk-child-model",
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
              return { sessionId: "sdk-child-model", toolCalls: 0, toolResults: 0 };
            },
            getLastAssistantText() {
              return `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"done"}`;
            },
            exportToJsonl(outputPath: string) {
              return outputPath;
            },
            dispose() {},
          },
        };
      },
    }));

    const { default: agents } = await import("../../../extensions/agents/index.js");
    const h = createHarness(tempRoot(), { sessionId: "parent-session" });
    h.ctx.model = { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" };
    h.pi.setThinkingLevel?.("high");
    agents(h.pi);

    await runTool(h, "task", { tasks: [{ id: "ShowModel", description: "Show model", assignment: "Return done" }] });

    const row = agentLiveStore.rows.get("task:task:ShowModel");
    expect(row).toMatchObject({
      model: "openai/gpt-5.5",
      thinking: "high",
      status: "done",
      finalAnswer: "done",
    });
  });

  it("returns isError when the child session returns a failed structured result", async () => {
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
            sessionId: "sdk-child-failed",
            subscribe(fn: (event: SdkAgentSessionEventLike) => void) {
              listener = fn;
              return () => {
                listener = undefined;
              };
            },
            async prompt() {
              listener?.({ type: "agent_end", willRetry: false });
            },
            getSessionStats() {
              return { sessionId: "sdk-child-failed", toolCalls: 0, toolResults: 0 };
            },
            getLastAssistantText() {
              return [
                AGENT_RESULT_MARKER,
                JSON.stringify({
                  version: "locus.agent.result.v1",
                  status: "failed",
                  summary: "Child failed.",
                  diagnostics: { reason: "tool denied" },
                }),
              ].join("\n");
            },
            exportToJsonl(outputPath: string) {
              return outputPath;
            },
            dispose() {},
          },
        };
      },
    }));

    const { default: agents } = await import("../../../extensions/agents/index.js");
    const h = createHarness(tempRoot(), { sessionId: "parent-session" });
    agents(h.pi);

    const result = await runTool(h, "task", { tasks: [{ id: "Fail", description: "Fail", assignment: "Return failed" }] });

    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(result.isError).toBe(true);
    expect(text).toContain("task task: 0/1 completed");
    expect(text).toContain("Fail: failed");
    expect(text).toContain("Child failed.");
    expect(result.details).toMatchObject({
      owner: "agents-catalog",
      requestedSurface: "task",
      requestedAgent: "task",
      agent: "task",
      status: "failed",
    });
    expect(result.details?.results).toEqual([
      expect.objectContaining({
        id: "Fail",
        status: "failed",
        reason: "Child failed.",
        diagnostics: expect.arrayContaining(["reason: tool denied"]),
      }),
    ]);
  });

  it("stops the progress spinner and surfaces a visible error when the run boundary throws", async () => {
    // A crash that escapes the per-task loop (e.g. host machinery throwing outside
    // the SDK executor's own try/catch) must finish the panel with ok:false so the
    // animation stops AND an "error:" line is shown — not silently spin forever.
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

    await expect(
      runTool(h, "spawn_agent", { tasks: [{ id: "Boom", description: "Boom", assignment: "explode" }] }),
    ).rejects.toThrow("simulated host crash mid-run");

    // Re-render the installed live widget: finish({ ok:false, error }) must have
    // disposed the timer and produced a visible error line.
    const factory = h.widgetPayloads.get("agents");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: () => {}, terminal: { rows: 30, columns: 100 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => { render(width: number): string[] })(stubTui, {});
    const rendered = component.render(100);
    expect(rendered.some((line) => line.includes("error") || line.includes("FAILED"))).toBe(true);

    vi.doUnmock("../../../extensions/_shared/agent-runner.js");
  });
});
