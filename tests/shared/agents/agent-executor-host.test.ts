import { describe, expect, it } from "vitest";
import {
  createAgentReplacementSessionExecutor,
  createAgentReplacementSessionHost,
  parseAgentTextFromEntries,
} from "../../../extensions/_shared/agent-runtime/agent-executor-host.js";
import {
  createAgentExecutionPromptCapsule,
  formatAgentKickoffPrompt,
  parseAgentText,
} from "../../../extensions/_shared/agent-runtime/agent-execution-prompt.js";
import { buildModelRolesState, resolveAgentModelPreference } from "../../../extensions/_shared/model/model-settings.js";
import type { AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import type {
  ExtensionCommandContext,
  ReplacementSessionContext,
  ReplacementSessionEntryLike,
} from "../../../extensions/_shared/host/pi-api.js";
import type { AgentDefinition } from "../../../extensions/_shared/agent-runtime/agents.js";
import { createHarness } from "../../test-harness.js";

const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "search", "yield"],
  tools: ["read", "search", "yield"],
  risk: "medium",
  readOnly: true,
  source: "project",
  filePath: "/repo/.agents/agents/reviewer.md",
};

function request(): AgentRunRequest {
  return {
    agent: reviewer,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: ["read", "search", "yield"],
    approvalTier: "allow",
  };
}

describe("agent replacement-session host", () => {
  it("reports unavailable when command context has no replacement-session API", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const host = createAgentReplacementSessionHost(h.ctx);
    const result = await host.runInChildSession({ request: request() }, new AbortController().signal);

    expect(host.available(h.ctx)).toBe(false);
    expect(result).toMatchObject({
      status: "blocked",
      reason: "Replacement-session host is unavailable.",
    });
  });

  it("tells the child to return exact text without a JSON envelope", () => {
    const capsule = createAgentExecutionPromptCapsule(request(), [], {
      LOCUS_AGENT_CONTEXT_EXTRAS: "0",
    });
    const prompt = formatAgentKickoffPrompt(capsule);

    expect(capsule).toMatchObject({
      version: "locus.agent.prompt.v1",
      agentName: "reviewer",
      task: "Review this change",
      projectRoot: "/repo",
      workingDirectory: "/repo",
      allowedTools: ["read", "search", "yield"],
    });
    expect(capsule).not.toHaveProperty("expectedResultMarker");
    expect(prompt).toContain("exact final non-empty message is the result");
    expect(prompt).toContain("Do not wrap the result in JSON");
    expect(prompt).not.toContain("locus.agent.result.v1");
  });

  it("includes model-role resolution and the selected persona in the capsule", () => {
    const state = buildModelRolesState(
      { user: "/user/config.json", project: "/repo/.pi/model-roles/config.json" },
      {},
      {},
      {},
      { version: 1, roles: { task: "test/strong:medium" } },
    );
    const capsule = createAgentExecutionPromptCapsule(
      {
        ...request(),
        agent: { ...reviewer, systemPrompt: "Review for correctness first." },
        modelRoleResolution: resolveAgentModelPreference(state),
      },
      [],
      {
        LOCUS_AGENT_CONTEXT_EXTRAS: "0",
      },
    );

    expect(capsule.modelRole).toMatchObject({
      role: "task",
      model: "test/strong",
      thinking: "medium",
    });
    expect(capsule.agentSystemPrompt).toContain("Review for correctness first.");
  });

  it("preserves plain and JSON-looking text exactly", () => {
    expect(parseAgentText("  Reviewed.\n")).toEqual({ ok: true, text: "  Reviewed.\n" });
    expect(parseAgentText('{"status":"failed","summary":"still text"}')).toEqual({
      ok: true,
      text: '{"status":"failed","summary":"still text"}',
    });
    expect(parseAgentText(" \n\t")).toEqual({ ok: false, reason: "Agent result text is empty." });
  });

  it("reads the last non-empty assistant message and ignores tool/user entries", () => {
    const entries: ReplacementSessionEntryLike[] = [
      { type: "message", role: "assistant", content: "first" },
      { type: "tool_result", role: "tool", content: "tool output" },
      { type: "message", role: "assistant", content: " \n" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "  exact final\n" }],
        },
      },
    ];

    expect(parseAgentTextFromEntries(entries)).toEqual({ ok: true, text: "  exact final\n" });
  });

  it("returns exact child text while keeping lifecycle metadata internal", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const replacementEntries: ReplacementSessionEntryLike[] = [
      {
        type: "message",
        role: "assistant",
        message: { role: "assistant", tool_calls: [{ name: "read" }] },
        content: "Inspecting files.",
      },
      { type: "tool_result", role: "tool", content: "file contents" },
      { type: "message", role: "assistant", content: "  Review complete.\nNo findings.\n" },
    ];
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (options) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return replacementEntries;
          },
        },
      };
      await options?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const result = await createAgentReplacementSessionExecutor(commandCtx).run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "completed",
      reason: "  Review complete.\nNo findings.\n",
      text: "  Review complete.\nNo findings.\n",
      childSession: { id: "child-session" },
      childOutputStats: {
        assistantToolCallCount: 1,
        toolResultCount: 1,
        hasWorkloadProof: true,
      },
    });
    expect(result).not.toHaveProperty("structuredResult");
  });

  it("fails on an empty final assistant result", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (options) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "empty-child", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{ type: "message", role: "assistant", content: "  " }];
          },
        },
      };
      await options?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const result = await createAgentReplacementSessionExecutor(commandCtx).run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "failed",
      reason: "Agent result text is empty.",
      childSession: { id: "empty-child" },
    });
  });

  it("maps cancelled replacement-session creation to cancellation", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async () => ({ cancelled: true, reason: "New session was cancelled" });

    const result = await createAgentReplacementSessionHost(commandCtx).runInChildSession(
      { request: request() },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "cancelled",
      reason: "New session was cancelled",
    });
  });
});
