import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  AGENT_RESULT_MARKER,
  createAgentReplacementSessionExecutor,
  createAgentExecutionPromptCapsule,
  createAgentReplacementSessionHost,
  formatAgentKickoffPrompt,
  parseAgentStructuredResultFromEntries,
  parseAgentStructuredResult,
} from "../../../extensions/_shared/agent-executor-host.js";
import { buildModelRolesState, resolveAgentModelPreference } from "../../../extensions/_shared/model-settings.js";
import type { AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import type { ExtensionCommandContext, ReplacementSessionContext, ReplacementSessionEntryLike } from "../../../extensions/_shared/pi-api.js";
import type { AgentDefinition } from "../../../extensions/_shared/types.js";
import { registerAgentWorkloadProofHooks, writeAgentWorkloadProof } from "../../../extensions/_shared/agent-workload-proof.js";
import { createHarness, emit } from "../../test-harness.js";

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
      diagnostics: ["Replacement-session host is unavailable."],
    });
  });

  it("builds a deterministic prompt capsule and kickoff prompt", () => {
    const capsule = createAgentExecutionPromptCapsule(request(), [], {
      LOCUS_AGENT_CONTEXT_EXTRAS: "0",
    });
    const prompt = formatAgentKickoffPrompt(capsule);

    expect(capsule).toEqual({
      version: "locus.agent.prompt.v1",
      agentName: "reviewer",
      agentDefinitionPath: "/repo/.agents/agents/reviewer.md",
      task: "Review this change",
      projectRoot: "/repo",
      workingDirectory: "/repo",
      allowedTools: ["read", "search", "yield"],
      maxTurns: 5,
      depth: 0,
      maxDepth: 1,
      expectedResultMarker: AGENT_RESULT_MARKER,
    });
    expect(prompt).toContain('"agentName": "reviewer"');
    // Plain text is the default contract: the child does work and replies in prose.
    expect(prompt).toContain("reply to the parent runtime in plain text");
    // The structured envelope is opt-in, demoted to a footnote — not the expected shape.
    expect(prompt).toContain("Structured output is OPT-IN");
    expect(prompt).toContain(AGENT_RESULT_MARKER);
    // When a child DOES opt into the envelope, it must use the exact status enum the
    // parser honors, so a cooperative structured report stays valid.
    expect(prompt).toContain('"completed", "failed", or "cancelled"');
  });

  it("includes agent model role resolution in the prompt capsule", () => {
    const state = buildModelRolesState(
      { user: "/user/config.json", project: "/repo/.pi/model-roles/config.json" },
      {},
      {},
      {},
      { version: 1, roles: { task: "test/strong:medium" } },
    );
    const capsule = createAgentExecutionPromptCapsule({
      ...request(),
      modelRoleResolution: resolveAgentModelPreference(state),
    }, [], {
      LOCUS_AGENT_CONTEXT_EXTRAS: "0",
    });

    expect(capsule.modelRole).toMatchObject({
      purpose: "agent",
      role: "task",
      source: "project",
      model: "test/strong",
      thinking: "medium",
      fallback: true,
    });
  });

  it("includes the selected agent persona in the prompt capsule", () => {
    const capsule = createAgentExecutionPromptCapsule({
      ...request(),
      agent: { ...reviewer, systemPrompt: "Review for correctness first." },
    }, [], {
      LOCUS_AGENT_CONTEXT_EXTRAS: "0",
    });

    expect(capsule.agentSystemPrompt).toContain('<active_agent name="reviewer"/>');
    expect(capsule.agentSystemPrompt).toContain("Working directory: /repo");
    expect(capsule.agentSystemPrompt).toContain("Review for correctness first.");
  });

  it("honors a valid envelope but falls back to plain text instead of hard-failing a botched one", () => {
    const valid = parseAgentStructuredResult(`${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Done"}`);
    const rawJson = parseAgentStructuredResult('{"version":"locus.agent.result.v1","status":"completed","summary":"Done from raw JSON","result":{"ok":true}}');
    const plainText = parseAgentStructuredResult("Reviewed the change without tool calls.");
    // Structured output is OPT-IN: a botched envelope must NOT fail the run. The
    // child did work and said something — we wrap that text as a completed result
    // rather than rejecting it. Honesty is enforced by workload proof, not JSON shape.
    const malformed = parseAgentStructuredResult(`${AGENT_RESULT_MARKER} {"version":`);
    const unsupportedStatus = parseAgentStructuredResult(`${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"running","summary":"Done"}`);

    expect(valid).toEqual({ ok: true, result: { version: "locus.agent.result.v1", status: "completed", summary: "Done" } });
    expect(rawJson).toEqual({ ok: true, result: { version: "locus.agent.result.v1", status: "completed", summary: "Done from raw JSON", result: { ok: true } } });
    expect(plainText).toEqual({ ok: true, result: { version: "locus.agent.result.v1", status: "completed", summary: "Reviewed the change without tool calls.", result: "Reviewed the change without tool calls." } });
    expect(malformed).toEqual({ ok: true, result: { version: "locus.agent.result.v1", status: "completed", summary: '{"version":', result: '{"version":' } });
    expect(unsupportedStatus).toEqual({ ok: true, result: { version: "locus.agent.result.v1", status: "completed", summary: '{"version":"locus.agent.result.v1","status":"running","summary":"Done"}', result: '{"version":"locus.agent.result.v1","status":"running","summary":"Done"}' } });
  });

  it("parses marked structured results after preceding review text", () => {
    const parsed = parseAgentStructuredResult([
      "Short review summary.",
      "",
      `${AGENT_RESULT_MARKER}`,
      '{"version":"locus.agent.result.v1","status":"completed","summary":"Done after prose"}',
    ].join("\n"));

    expect(parsed).toEqual({
      ok: true,
      result: { version: "locus.agent.result.v1", status: "completed", summary: "Done after prose" },
    });
  });

  it("normalizes object and string diagnostics instead of masking the child result", () => {
    const objectDiagnostics = parseAgentStructuredResult([
      AGENT_RESULT_MARKER,
      JSON.stringify({
        version: "locus.agent.result.v1",
        status: "failed",
        summary: "Child hit a real problem.",
        diagnostics: {
          reason: "tool denied",
          detail: { code: "approval_required" },
        },
      }),
    ].join("\n"));
    const stringDiagnostics = parseAgentStructuredResult([
      AGENT_RESULT_MARKER,
      JSON.stringify({
        version: "locus.agent.result.v1",
        status: "failed",
        summary: "Child hit another problem.",
        diagnostics: "plain diagnostic",
      }),
    ].join("\n"));

    expect(objectDiagnostics).toEqual({
      ok: true,
      result: {
        version: "locus.agent.result.v1",
        status: "failed",
        summary: "Child hit a real problem.",
        diagnostics: ["reason: tool denied", 'detail: {"code":"approval_required"}'],
      },
    });
    expect(stringDiagnostics).toEqual({
      ok: true,
      result: {
        version: "locus.agent.result.v1",
        status: "failed",
        summary: "Child hit another problem.",
        diagnostics: ["plain diagnostic"],
      },
    });
  });

  it("parses structured results from real Pi message entries", () => {
    const parsed = parseAgentStructuredResultFromEntries([{
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Done from Pi entry"}`,
        }],
      },
    }]);

    expect(parsed).toEqual({
      ok: true,
      result: { version: "locus.agent.result.v1", status: "completed", summary: "Done from Pi entry" },
    });
  });

  it("normalizes object-shaped structured artifacts from real reviewer output", () => {
    const parsed = parseAgentStructuredResult([
      AGENT_RESULT_MARKER,
      JSON.stringify({
        version: "locus.agent.result.v1",
        status: "completed",
        summary: "Done",
        artifacts: {
          taskId: "T-108",
          planFile: ".tasks/T-108/plan.md",
          filesReviewed: ["scripts/smoke-prompt-commands.ts"],
        },
      }),
    ].join("\n"));

    expect(parsed).toEqual({
      ok: true,
      result: {
        version: "locus.agent.result.v1",
        status: "completed",
        summary: "Done",
        artifacts: [
          { path: ".tasks/T-108/plan.md", title: "planFile" },
          { path: "scripts/smoke-prompt-commands.ts", title: "filesReviewed" },
        ],
      },
    });
  });

  it("normalizes path-string artifact arrays from child structured results", () => {
    const parsed = parseAgentStructuredResult([
      AGENT_RESULT_MARKER,
      JSON.stringify({
        version: "locus.agent.result.v1",
        status: "completed",
        summary: "Created test file.",
        artifacts: ["/repo/test.md"],
      }),
    ].join("\n"));

    expect(parsed).toEqual({
      ok: true,
      result: {
        version: "locus.agent.result.v1",
        status: "completed",
        summary: "Created test file.",
        artifacts: [{ path: "/repo/test.md" }],
      },
    });
  });

  it("runs through a mock replacement session without using the parent sendUserMessage API", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    let kickoff = "";
    const replacementEntries: ReplacementSessionEntryLike[] = [
      { type: "message", role: "assistant", message: { role: "assistant", tool_calls: [{ name: "read" }] }, content: "Inspecting files." },
      { type: "tool_result", role: "tool", content: "file contents" },
      { type: "message", role: "assistant", content: `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Reviewed","diagnostics":[]}` },
    ];
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage(message) { kickoff = message; },
        async waitForIdle() {},
        sessionManager: {
          getEntries() { return replacementEntries; },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const host = createAgentReplacementSessionHost(commandCtx);
    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run(request(), new AbortController().signal);

    expect(host.available(commandCtx)).toBe(true);
    expect(kickoff).toContain('"task": "Review this change"');
    expect(h.notifications).toEqual([]);
    expect(result).toMatchObject({
      status: "completed",
      reason: "Reviewed",
      childSession: { id: "child-session" },
      structuredResult: { version: "locus.agent.result.v1", status: "completed", summary: "Reviewed" },
    });
    expect(result.childOutputStats).toMatchObject({
      assistantToolCallCount: 1,
      toolResultCount: 1,
      hasWorkloadProof: true,
    });
  });

  it("uses child-session output captured inside official newSession instead of trusting the newSession return value", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const replacementEntries: ReplacementSessionEntryLike[] = [
      { type: "message", message: { role: "assistant", tool_calls: [{ name: "search" }], content: "Searching." } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Reviewed via official contract"}`,
          }],
        },
      },
    ];
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() { return replacementEntries; },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "completed",
      reason: "Reviewed via official contract",
      childSession: { id: "child-session" },
      diagnostics: [],
      childOutputStats: {
        entryCount: 2,
        assistantMessageCount: 2,
        assistantToolCallCount: 1,
        toolResultCount: 0,
        hasWorkloadProof: true,
      },
    });
  });

  it("installs the selected agent persona through a bound replacement-session setup message", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const installedMessages: Array<{ role: string; content: string; timestamp?: number }> = [];
    const setupSessionManager = {
      appendMessage(message: { role: string; content: string; timestamp?: number }) {
        if (this !== setupSessionManager) throw new Error("appendMessage was not bound to SessionManager");
        installedMessages.push(message);
        return "ok";
      },
    };
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      await opts?.setup?.(setupSessionManager);
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "persona-child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{
              type: "message",
              role: "assistant",
              content: "Persona-aware answer.",
            }];
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run({
      ...request(),
      agent: { ...reviewer, systemPrompt: "Review for correctness first." },
    }, new AbortController().signal);

    expect(installedMessages).toHaveLength(1);
    expect(installedMessages[0]).toMatchObject({ role: "user" });
    expect(installedMessages[0]?.timestamp).toEqual(expect.any(Number));
    expect(installedMessages[0]?.content).toContain('<active_agent name="reviewer"/>');
    expect(installedMessages[0]?.content).toContain("Review for correctness first.");
    expect(result.status).toBe("completed");
  });

  it("layers opt-in extras into the replacement-session setup prompt in stable order", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-replacement-extras-"));
    const memoryPath = path.join(root, "MEMORY.md");
    writeFileSync(memoryPath, ["MEMORY_SENTINEL", ...Array.from({ length: 204 }, (_, index) => `memory-line-${index + 2}`)].join("\n"), "utf8");
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, ["SKILL_SENTINEL", ...Array.from({ length: 204 }, (_, index) => `skill-line-${index + 2}`)].join("\n"), "utf8");
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_MEMORY_FILE: memoryPath,
      LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
    } as NodeJS.ProcessEnv;

    const h = createHarness(root, { sessionId: "parent-session" });
    const installedMessages: Array<{ role: string; content: string; timestamp?: number }> = [];
    const setupSessionManager = {
      appendMessage(message: { role: string; content: string; timestamp?: number }) {
        if (this !== setupSessionManager) throw new Error("appendMessage was not bound to SessionManager");
        installedMessages.push(message);
        return "ok";
      },
    };
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      await opts?.setup?.(setupSessionManager);
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "extras-child-session", projectRoot: root, workingDirectory: root },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{
              type: "message",
              role: "assistant",
              content: "Replacement extras result.",
            }];
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx, {
      promptEnv: env,
    });
    const result = await executor.run({
      ...request(),
      projectRoot: root,
      workingDirectory: root,
      agent: { ...reviewer, systemPrompt: "Review for correctness first." },
    }, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(installedMessages).toHaveLength(1);
    const setupPrompt = installedMessages[0]?.content ?? "";
    expect(setupPrompt).toContain('<active_agent name="reviewer"/>');
    expect(setupPrompt).toContain("Review for correctness first.");
    expect(setupPrompt).toContain("# Context extras");
    expect(setupPrompt).toContain("## Memory");
    expect(setupPrompt).toContain("MEMORY_SENTINEL");
    expect(setupPrompt).toContain("First 200 lines kept.");
    expect(setupPrompt).toContain("## Skill: reviewer");
    expect(setupPrompt).toContain(`Source: ${skillPath}`);
    expect(setupPrompt).toContain("Requested: reviewer");
    expect(setupPrompt).toContain("SKILL_SENTINEL");
    expect(setupPrompt.indexOf("Review for correctness first.")).toBeLessThan(setupPrompt.indexOf("MEMORY_SENTINEL"));
  });

  it("counts assistant tool calls separately from parser-clean results", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "tool-call-entry-child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{
              type: "message",
              message: {
                role: "assistant",
                tool_calls: [{ name: "bash" }],
                content: [{
                  type: "text",
                  text: `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Worked"}`,
                }],
              },
            }];
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run(request(), new AbortController().signal);

    expect(result.childOutputStats).toMatchObject({
      entryCount: 1,
      assistantMessageCount: 1,
      assistantToolCallCount: 1,
      hasWorkloadProof: true,
    });
  });

  it("records lifecycle proof diagnostics while accepting reasoning-only completion", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    registerAgentWorkloadProofHooks(h.pi);
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const childSessionId = "child-session";
      const replacementEntries: ReplacementSessionEntryLike[] = [
        { type: "message", role: "assistant", content: `I inspected a file.\n${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Done"}` },
      ];
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: childSessionId, projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {
          await emit(h, "tool_call", { sessionId: childSessionId, toolName: "ast_grep" });
          await emit(h, "tool_result", { sessionId: childSessionId, toolName: "ast_grep" });
        },
        sessionManager: {
          getSessionId() { return childSessionId; },
          getEntries() { return replacementEntries; },
          getSessionFile() { return undefined; },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };
    const executor = createAgentReplacementSessionExecutor(commandCtx);

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.reason).toBe("Done");
    expect(result.childOutputStats).toMatchObject({
      assistantToolCallCount: 0,
      toolResultCount: 0,
      recordedToolCallCount: 1,
      recordedToolResultCount: 1,
      recordedToolNames: ["ast_grep"],
      hasWorkloadProof: false,
    });
  });

  it("accepts transcript tool blocks as child workload proof when Pi entries render tool output as text", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementEntries: ReplacementSessionEntryLike[] = [
        {
          type: "message",
          role: "assistant",
          content: [
            "I will inspect the bounded file.",
            "",
            "ast_grep",
            "/repo/file.ts:1:1: const value = 1;",
            "",
            `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Done","diagnostics":[{"severity":"info","message":"ok"}]}`,
          ].join("\n"),
        },
      ];
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "transcript-proof-child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getSessionId() { return "transcript-proof-child-session"; },
          getEntries() { return replacementEntries; },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run({
      ...request(),
      allowedTools: ["read", "ast_grep", "yield"],
      agent: { ...reviewer, allowedTools: ["read", "ast_grep", "yield"], tools: ["read", "ast_grep", "yield"] },
    }, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.diagnostics).toEqual(['{"severity":"info","message":"ok"}']);
    expect(result.childOutputStats).toMatchObject({
      transcriptToolBlockCount: 1,
      transcriptToolNames: ["ast_grep"],
      hasWorkloadProof: true,
    });
  });

  it("records persisted proof while accepting parser-clean completion", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-proof-"));
    const h = createHarness(root, { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const childSessionId = "persisted-proof-child-session";
      const replacementEntries: ReplacementSessionEntryLike[] = [
        { type: "message", role: "assistant", content: `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Done"}` },
      ];
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: childSessionId, projectRoot: root, workingDirectory: root },
        async sendUserMessage() {},
        async waitForIdle() {
          writeAgentWorkloadProof(replacementCtx, "locus_workload_proof");
        },
        sessionManager: {
          getSessionId() { return childSessionId; },
          getEntries() { return replacementEntries; },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run({
      ...request(),
      projectRoot: root,
      workingDirectory: root,
      allowedTools: ["read", "locus_workload_proof", "yield"],
      agent: { ...reviewer, allowedTools: ["read", "locus_workload_proof", "yield"], tools: ["read", "locus_workload_proof", "yield"] },
    }, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.reason).toBe("Done");
    expect(result.childOutputStats).toMatchObject({
      recordedToolCallCount: 1,
      recordedToolResultCount: 1,
      recordedToolNames: ["locus_workload_proof"],
      hasWorkloadProof: false,
    });
  });

  it("accepts parser-clean output without child workload proof", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "parser-clean-child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{
              type: "message",
              role: "assistant",
              content: `${AGENT_RESULT_MARKER} {"version":"locus.agent.result.v1","status":"completed","summary":"Parser clean only"}`,
            }];
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "completed",
      reason: "Parser clean only",
      childOutputStats: {
        assistantToolCallCount: 0,
        toolResultCount: 0,
        hasWorkloadProof: false,
      },
    });
  });

  it("wraps free-text replacement-session answers as completed results", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async (opts) => {
      const replacementCtx: ReplacementSessionContext = {
        ...h.ctx,
        session: { id: "plain-text-child-session", projectRoot: "/repo", workingDirectory: "/repo" },
        async sendUserMessage() {},
        async waitForIdle() {},
        sessionManager: {
          getEntries() {
            return [{
              type: "message",
              role: "assistant",
              content: "I reviewed the requested change and found no issues.",
            }];
          },
        },
      };
      await opts?.withSession?.(replacementCtx);
      return { cancelled: false };
    };

    const executor = createAgentReplacementSessionExecutor(commandCtx);
    const result = await executor.run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "completed",
      reason: "I reviewed the requested change and found no issues.",
      structuredResult: {
        version: "locus.agent.result.v1",
        status: "completed",
        summary: "I reviewed the requested change and found no issues.",
        result: "I reviewed the requested change and found no issues.",
      },
    });
  });

  it("maps cancelled replacement-session creation to a cancelled host result", async () => {
    const h = createHarness("/repo", { sessionId: "parent-session" });
    const commandCtx = h.ctx as ExtensionCommandContext;
    commandCtx.newSession = async () => ({ cancelled: true, reason: "New session was cancelled" });

    const host = createAgentReplacementSessionHost(commandCtx);
    const result = await host.runInChildSession({ request: request() }, new AbortController().signal);

    expect(result).toMatchObject({
      status: "cancelled",
      reason: "New session was cancelled",
      diagnostics: ["New session was cancelled"],
    });
  });
});
