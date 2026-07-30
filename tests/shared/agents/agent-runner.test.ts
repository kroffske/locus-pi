import { describe, expect, it } from "vitest";
import {
  type AgentRunRequest,
  createAgentRunRequest,
  executeAgentRunBoundary,
  validateRunPolicy,
} from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { MemorySessionStore, createDeterministicSessionIdFactory } from "../../../extensions/_shared/session-core.js";
import type { AgentDefinition } from "../../../extensions/_shared/types.js";
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

function fullRequest(input: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    ...createAgentRunRequest(reviewer, "Task", { approvalTier: "allow", ...input }),
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
  };
}

describe("agent runner contract", () => {
  it("blocks without an executor while recording child lifecycle entries", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const store = new MemorySessionStore({
      idFactory: createDeterministicSessionIdFactory("m10"),
      now: () => "2026-06-02T00:00:00.000Z",
    });

    const result = await executeAgentRunBoundary({
      pi: h.pi,
      ctx: h.ctx,
      sessionStore: store,
      request: createAgentRunRequest(reviewer, "Review this change", { approvalTier: "allow" }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      agentName: "reviewer",
      reason: "No agent executor is configured.",
    });
    expect(result.childSession?.id).toBe("m10-session-1-child-of-parent-session");
    expect(result.lifecycleEntryIds).toHaveLength(2);
    expect(store.latestEntry("parent-session", "child_run")).toMatchObject({
      payload: {
        childSessionId: result.childSession?.id,
        status: "failed",
      },
    });
    expect(store.latestEntry(result.childSession!.id, "message")?.payload.content).toContain(
      "Agent run requested for reviewer.",
    );
  });

  it("enforces budgets, depth, and allowed tools before creating a child run", () => {
    expect(validateRunPolicy(fullRequest({ maxTurns: 0 }))).toBe("maxTurns must be between 1 and 20.");
    expect(validateRunPolicy(fullRequest({ depth: 1, maxDepth: 1 }))).toBe("Agent run depth limit reached.");
    expect(validateRunPolicy(fullRequest({ allowedTools: ["read", "bash"] }))).toBe(
      "Requested tools exceed the agent definition allow-list.",
    );
  });

  it("does not run local approval prompts before creating a child run", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    h.ctx.ui.confirm = async () => false;
    const store = new MemorySessionStore({
      idFactory: createDeterministicSessionIdFactory("m10"),
      now: () => "2026-06-02T00:00:00.000Z",
    });

    const result = await executeAgentRunBoundary({
      pi: h.pi,
      ctx: h.ctx,
      sessionStore: store,
      request: createAgentRunRequest(reviewer, "Review this change", { approvalTier: "prompt" }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "No agent executor is configured.",
    });
    expect(result.childSession?.id).toBe("m10-session-1-child-of-parent-session");
    expect(store.getSession("parent-session")).not.toBeUndefined();
    expect(h.entries.filter((entry) => entry.type === "decision")).toHaveLength(0);
  });
});
