import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import {
  createAgentSdkSessionExecutor,
  type CreateAgentSessionFactory,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
} from "../../../extensions/_shared/agent-sdk-host.js";
import {
  writeAgentRunResultArtifact,
  type AgentRunRequest,
  type AgentRunResult,
} from "../../../extensions/_shared/agent-runner.js";
import type { AgentDefinition } from "../../../extensions/_shared/types.js";

const baseAgent: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "grep"],
  risk: "medium",
  readOnly: true,
  evidence: { mode: "none" },
};

function request(agent: AgentDefinition = baseAgent): AgentRunRequest {
  const root = mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-"));
  return {
    agent,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: root,
    workingDirectory: root,
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: agent.allowedTools,
    approvalTier: "allow",
  };
}

function fakeSession(config: {
  toolCalls: number;
  toolResults: number;
  text: string;
  events?: SdkAgentSessionEventLike[];
  exportHeaderId?: string;
  exportRawHeader?: string;
  exportOutsideReports?: boolean;
  exportError?: string;
  neverEnds?: boolean;
}): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  return {
    sessionId: "sdk-child",
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      for (const event of config.events ?? []) listener?.(event);
      if (config.neverEnds !== true) listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "sdk-child", toolCalls: config.toolCalls, toolResults: config.toolResults };
    },
    getLastAssistantText() {
      return config.text;
    },
    exportToJsonl(outputPath) {
      if (config.exportError !== undefined) throw new Error(config.exportError);
      const target = config.exportOutsideReports
        ? path.join(exportDir, "escaped.jsonl")
        : (outputPath ?? path.join(exportDir, "session.jsonl"));
      const header =
        config.exportRawHeader ??
        JSON.stringify({ type: "session", version: 3, id: config.exportHeaderId ?? "sdk-child" });
      writeFileSync(target, `${header}\n`, "utf8");
      return target;
    },
    dispose() {},
    async abort() {},
  };
}

function completedText(summary: string): string {
  return summary;
}

describe("agent SDK evidence surfacing", () => {
  it("attaches reasoning_only evidence for policy mode none with no tools", async () => {
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.deepEqual(result.evidence, {
      evidence: "reasoning_only",
      warnings: [],
      missingRequiredTools: [],
      observedTools: [],
    });
  });

  it("attaches missing_expected_evidence warnings for warn policy with no tool calls", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      evidence: { mode: "warn", requireAnyOf: ["read", "grep"] },
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(agent), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.equal(result.evidence?.evidence, "missing_expected_evidence");
    assert.deepEqual(result.evidence?.missingRequiredTools, ["read", "grep"]);
    assert.ok((result.evidence?.warnings.length ?? 0) > 0);
  });

  it("records a real-shaped SDK bash event and satisfies named-tool evidence", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      allowedTools: ["bash"],
      evidence: { mode: "warn", requireAnyOf: ["bash"] },
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 1,
          toolResults: 1,
          text: completedText("Checked."),
          events: [
            { type: "tool_execution_start", toolName: " bash ", toolCallId: "call-1", args: { command: "pwd" } },
            { type: "tool_execution_update", toolName: "bash", toolCallId: "call-1", args: { command: "pwd" } },
            { type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", isError: false },
          ],
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(agent), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.deepEqual(result.childOutputStats?.recordedToolNames, ["bash"]);
    assert.deepEqual(result.evidence, {
      evidence: "evidence_backed",
      warnings: [],
      missingRequiredTools: [],
      observedTools: ["bash"],
    });
  });

  it("does not invent a named tool from aggregate SDK counters", async () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      allowedTools: ["bash"],
      evidence: { mode: "warn", requireAnyOf: ["bash"] },
    };
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({
          toolCalls: 1,
          toolResults: 1,
          text: completedText("Checked."),
          events: [
            { type: "step_start", name: "bash" },
            { type: "tool_hint", toolName: "bash" },
          ],
        }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(agent), new AbortController().signal);

    assert.equal(result.status, "completed");
    assert.deepEqual(result.childOutputStats?.recordedToolNames, []);
    assert.equal(result.evidence?.evidence, "missing_expected_evidence");
    assert.deepEqual(result.evidence?.missingRequiredTools, ["bash"]);
    assert.deepEqual(result.evidence?.observedTools, []);
  });

  it("omits evidence from run-result artifact body when AgentRunResult evidence is undefined", () => {
    const req = request();
    const result: AgentRunResult = {
      status: "completed",
      agentName: req.agent.name,
      reason: "ok",
      diagnostics: [],
      lifecycleEntryIds: [],
    };

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    assert.ok(withArtifact.resultArtifact !== undefined);
    const body = JSON.parse(withArtifact.resultArtifact.content) as Record<string, unknown>;
    assert.equal(body.version, "locus.agent.run-result.v1");
    assert.equal(Object.hasOwn(body, "evidence"), false);
  });

  it("exposes a reports-confined, session-bound child trace and serializes it separately from the run result", async () => {
    const req = request();
    const reportsDir = path.join(req.projectRoot ?? process.cwd(), ".locus", "runtime", "reports");
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed.") }),
      })) as CreateAgentSessionFactory,
      reportsDir,
      now: () => "fixed",
    });

    const result = await executor.run(req, new AbortController().signal);
    assert.deepEqual(result.childTrace, {
      path: realpathSync(path.join(reportsDir, "agent-sdk-reviewer-fixed.jsonl")),
      format: "pi-session-jsonl",
      childSessionId: "sdk-child",
    });

    const withArtifact = writeAgentRunResultArtifact(req.projectRoot ?? process.cwd(), req, result);
    assert.ok(withArtifact.resultArtifact !== undefined);
    assert.notEqual(withArtifact.resultArtifact.path, result.childTrace?.path);
    const body = JSON.parse(withArtifact.resultArtifact.content) as Record<string, unknown>;
    assert.deepEqual(body.childTrace, result.childTrace);
  });

  it.each([
    ["escaped path", { exportOutsideReports: true }, "escaped reports root"],
    ["malformed header", { exportRawHeader: "{not-json}" }, "JSONL export failed:"],
    ["wrong session", { exportHeaderId: "other-child" }, "does not match child"],
    ["export error", { exportError: "disk refused" }, "disk refused"],
  ])("omits childTrace after %s validation failure", async (_name, exportConfig, diagnostic) => {
    const executor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: completedText("Reviewed."), ...exportConfig }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);
    assert.equal(result.childTrace, undefined);
    assert.ok(result.diagnostics.some((line) => line.includes("JSONL export failed:") && line.includes(diagnostic)));
  });

  it("preserves an exported child trace on parse failure, timeout and cancellation", async () => {
    const parseExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "" }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "parse",
    });
    const parsed = await parseExecutor.run(request(), new AbortController().signal);
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.childTrace?.childSessionId, "sdk-child");

    const timeoutExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "", neverEnds: true }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "timeout",
      turnTimeoutMs: 1,
    });
    const timedOut = await timeoutExecutor.run(request(), new AbortController().signal);
    assert.equal(timedOut.status, "failed");
    assert.equal(timedOut.childTrace?.childSessionId, "sdk-child");

    const cancelExecutor = createAgentSdkSessionExecutor({
      createSession: (async () => ({
        session: fakeSession({ toolCalls: 0, toolResults: 0, text: "", neverEnds: true }),
      })) as CreateAgentSessionFactory,
      reportsDir: mkdtempSync(path.join(tmpdir(), "locus-agent-evidence-reports-")),
      now: () => "cancelled",
      turnTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = cancelExecutor.run(request(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.childTrace?.childSessionId, "sdk-child");
  });
});
