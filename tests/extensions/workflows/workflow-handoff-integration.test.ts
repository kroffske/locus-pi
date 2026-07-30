import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindWorkflowHandoffClaim,
  createWorkflowOperatorHandoffEnvelope,
  readCurrentWorkflowScriptIdentity,
} from "../../../extensions/workflows/runtime/workflow-handoff.js";
import type { CustomUiFactory } from "../../../extensions/_shared/host/pi-api.js";
import * as runner from "../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowTarget } from "../../../extensions/workflows/runtime/workflow-runner.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness, emit } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithHandoff(runId: string, existingRoot?: string): string {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), "workflow-handoff-integration-"));
  if (existingRoot === undefined) roots.push(root);
  const workflowsDir = path.join(root, ".pi", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  const sourcePath = path.join(workflowsDir, "alpha.workflow.mjs");
  writeFileSync(
    sourcePath,
    'export const meta={name:"alpha",description:"Alpha"}; export default async()=>({ok:true});\n',
    "utf8",
  );
  const target = resolveWorkflowTarget({ script: "alpha" }, root, root);
  const currentIdentity = readCurrentWorkflowScriptIdentity(target.path);
  const scriptIdentity = {
    ...currentIdentity,
    sourcePath: target.path,
    snapshotPath: path.join(root, ".locus", "runtime", "workflows", runId, "script.workflow.mjs"),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinImports: [],
    unboundDependencies: [],
  };
  const artifactRef = {
    runId,
    artifactId: "intent",
    name: "intent.md",
    sha256: "0".repeat(64),
  };
  const operatorHandoff = createWorkflowOperatorHandoffEnvelope({
    declaration: {
      title: "Review clarification",
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose review scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
          recommended: "Current changes",
          allowCustom: true,
        },
      ],
      continuationArtifactRefs: [artifactRef],
    },
    runId,
    target,
    scriptIdentity,
    terminalArtifactRefs: [artifactRef],
  });
  const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify({
      runId,
      ok: true,
      result: { mode: "prepared" },
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
      journal: [],
      resultPersistence: { ok: true, path: path.join(runDir, "result.json") },
      target,
      scriptIdentity,
      artifactRefs: [artifactRef],
      operatorHandoff,
    })}\n`,
    "utf8",
  );
  return root;
}

function corruptPersistedHandoff(root: string, runId: string): void {
  const resultPath = path.join(root, ".locus", "runtime", "workflows", runId, "result.json");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  result.operatorHandoff = { ...(result.operatorHandoff as Record<string, unknown>), title: 42 };
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}

function persistCompletedChild(root: string, runId: string): void {
  const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify({
      runId,
      ok: true,
      result: { summary: "continued" },
      disposition: { status: "completed" },
      journal: [],
      resultPersistence: { ok: true, path: path.join(runDir, "result.json") },
    })}\n`,
    "utf8",
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Promise.resolve();
}

async function flushBackground(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
}

function completedResult(runId: string): runner.RunWorkflowScriptResult {
  return {
    runId,
    runDir: `/tmp/${runId}`,
    ok: true,
    result: { summary: "continued" },
    disposition: { status: "completed" },
    journal: [],
    resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
  };
}

describe("workflow actionable handoff integration", () => {
  it("recovers on session start, claims, and launches through the ordinary background runner", async () => {
    const sourceRunId = "20260725-120000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-${Date.now()}` });
    harness.customInputQueue.push("\r");
    const requests: runner.RunWorkflowScriptOptions[] = [];
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      request.onRunStart?.({ runId: "20260725-120100-child", runDir: "/tmp/20260725-120100-child" });
      return completedResult("20260725-120100-child");
    });

    workflows(harness.pi);
    await emit(harness, "session_start");
    await waitFor(() => requests.length === 1);
    await waitFor(() => harness.waitForIdleCalls === 2);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      script: "alpha",
      input: "Current changes",
      continuation: {
        originRunId: sourceRunId,
        artifactRefs: [expect.objectContaining({ name: "intent.md" })],
      },
      operatorHandoffClaim: {
        sourceRunId,
      },
    });
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Question 1 of 1");
    expect(harness.customOptions[0]).toEqual({ overlay: false });
    expect(harness.waitForIdleCalls).toBe(2);
    expect(harness.sentUserMessages).toEqual([]);
  });

  it("does not reopen a snoozed question on agent_settled and bare /workflows recovers it", async () => {
    const sourceRunId = "20260725-121000-source";
    const root = projectWithHandoff(sourceRunId);
    const harness = createHarness(root, { sessionId: `handoff-snooze-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      request.onRunStart?.({ runId: "20260725-121100-child", runDir: "/tmp/20260725-121100-child" });
      return completedResult("20260725-121100-child");
    });
    workflows(harness.pi);

    harness.customInputQueue.push("\x1b");
    await emit(harness, "session_start");
    await waitFor(() => harness.customComponents.length === 1);
    expect(requests).toEqual([]);
    expect(harness.customComponents).toHaveLength(1);

    await emit(harness, "agent_settled");
    await flushBackground();
    expect(harness.customComponents).toHaveLength(1);
    expect(requests).toEqual([]);

    harness.customInputQueue.push("\r");
    await harness.commands.get("workflows")!.handler("", harness.ctx);
    await waitFor(() => requests.length === 1);
    expect(requests).toHaveLength(1);
    expect(harness.customComponents).toHaveLength(2);
  });

  it("does not mount a tool-origin question on turn_end and uses the fresh agent_settled context", async () => {
    const sourceRunId = "20260725-122000-source";
    const root = projectWithHandoff(sourceRunId);
    const resultPath = path.join(root, ".locus", "runtime", "workflows", sourceRunId, "result.json");
    const deferredPath = `${resultPath}.deferred`;
    renameSync(resultPath, deferredPath);
    const harness = createHarness(root, { sessionId: `handoff-settled-${Date.now()}` });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      request.onRunStart?.({ runId: "20260725-122100-child", runDir: "/tmp/20260725-122100-child" });
      return completedResult("20260725-122100-child");
    });
    workflows(harness.pi);
    await emit(harness, "session_start");
    await flushBackground();
    renameSync(deferredPath, resultPath);

    await emit(harness, "turn_end");
    expect(harness.customComponents).toEqual([]);
    expect(requests).toEqual([]);

    harness.customInputQueue.push("\r");
    await emit(harness, "agent_settled");
    await waitFor(() => requests.length === 1);
    expect(harness.customComponents).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("continues one explicit answer in JSON mode through the flat command without interactive UI", async () => {
    const sourceRunId = "20260725-123000-source";
    const root = projectWithHandoff(sourceRunId);
    const resultPath = path.join(root, ".locus", "runtime", "workflows", sourceRunId, "result.json");
    const deferredPath = `${resultPath}.deferred`;
    renameSync(resultPath, deferredPath);
    const harness = createHarness(root, {
      sessionId: `handoff-json-${Date.now()}`,
      mode: "json",
    });
    const requests: runner.RunWorkflowScriptOptions[] = [];
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      request.onRunStart?.({ runId: "20260725-123100-child", runDir: "/tmp/20260725-123100-child" });
      return completedResult("20260725-123100-child");
    });
    workflows(harness.pi);
    await emit(harness, "session_start");
    await flushBackground();
    renameSync(deferredPath, resultPath);

    expect(harness.commands.get("workflow-continue")?.getArgumentCompletions?.(`${sourceRunId} `)).toEqual([
      expect.objectContaining({ value: `${sourceRunId} --answer `, label: "--answer" }),
    ]);
    await harness.commands.get("workflow-continue")!.handler(`${sourceRunId} --answer Last commit`, harness.ctx);
    await waitFor(() => requests.length === 1);

    expect(requests[0]).toMatchObject({
      input: "Last commit",
      continuation: { originRunId: sourceRunId },
    });
    expect(harness.customComponents).toEqual([]);
    expect(harness.selectCalls).toEqual([]);
  });

  it("does not let a never-resolving question starve later lifecycle handlers", async () => {
    const root = projectWithHandoff("20260725-124000-source");
    const harness = createHarness(root, { sessionId: `handoff-never-${Date.now()}` });
    let mounted = 0;
    harness.ctx.ui.custom = vi.fn(
      async <T>(factory: CustomUiFactory<T>) =>
        await new Promise<T>(async () => {
          await factory({ requestRender() {} }, {}, {}, () => {});
          mounted += 1;
        }),
    ) as NonNullable<typeof harness.ctx.ui.custom>;
    workflows(harness.pi);

    await emit(harness, "session_start");
    await waitFor(() => mounted === 1);
    await emit(harness, "session_start");
    await emit(harness, "agent_settled");

    expect(mounted).toBe(1);
    expect(harness.ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected question pump as a warning without rejecting the lifecycle handler", async () => {
    const root = projectWithHandoff("20260725-125000-source");
    const harness = createHarness(root, { sessionId: `handoff-reject-${Date.now()}` });
    harness.ctx.ui.custom = vi.fn(async () => {
      throw new Error("question mount exploded");
    });
    workflows(harness.pi);

    await expect(emit(harness, "session_start")).resolves.toEqual([undefined]);
    await waitFor(() => (harness.widgets.get("workflows") ?? "").includes("question mount exploded"));

    expect(harness.widgets.get("workflows")).toContain("question mount exploded");
    expect(harness.widgets.get("workflows")).toContain("No workflow execution was started.");
  });

  it("pumps the next FIFO handoff after the answered child reaches a terminal result", async () => {
    const firstRunId = "20260725-130000-first";
    const secondRunId = "20260725-131000-second";
    const root = projectWithHandoff(firstRunId);
    projectWithHandoff(secondRunId, root);
    const harness = createHarness(root, { sessionId: `handoff-fifo-${Date.now()}` });
    harness.customInputQueue.push("\r", "\r");
    const requests: runner.RunWorkflowScriptOptions[] = [];
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      const childRunId = `20260725-13200${requests.length}-child`;
      bindWorkflowHandoffClaim(request.operatorHandoffClaim!, childRunId);
      persistCompletedChild(root, childRunId);
      request.onRunStart?.({ runId: childRunId, runDir: `/tmp/${childRunId}` });
      return completedResult(childRunId);
    });
    workflows(harness.pi);

    await emit(harness, "session_start");
    await waitFor(() => requests.length === 2);

    expect(requests.map((request) => request.continuation?.originRunId)).toEqual([firstRunId, secondRunId]);
    expect(harness.customComponents).toHaveLength(2);
  });

  it("reports a malformed durable handoff instead of showing the no-attention home", async () => {
    const runId = "20260725-133000-malformed";
    const root = projectWithHandoff(runId);
    corruptPersistedHandoff(root, runId);
    const harness = createHarness(root, { sessionId: `handoff-malformed-${Date.now()}` });
    workflows(harness.pi);

    await emit(harness, "session_start");
    await waitFor(() => (harness.widgets.get("workflows") ?? "").includes("operatorHandoff title"));

    expect(harness.widgets.get("workflows")).toContain("operatorHandoff title");
    expect(harness.widgets.get("workflows")).not.toContain("No workflow needs an answer");
    expect(harness.commands.get("workflow-continue")?.getArgumentCompletions?.("20260725")).toEqual([]);
  });

  it("lets a valid actionable handoff win over malformed historical evidence", async () => {
    const malformedRunId = "20260725-134000-malformed";
    const actionableRunId = "20260725-135000-actionable";
    const root = projectWithHandoff(malformedRunId);
    corruptPersistedHandoff(root, malformedRunId);
    projectWithHandoff(actionableRunId, root);
    const harness = createHarness(root, { sessionId: `handoff-valid-wins-${Date.now()}` });
    harness.customInputQueue.push("\r");
    const requests: runner.RunWorkflowScriptOptions[] = [];
    vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      requests.push(request);
      request.onRunStart?.({ runId: "20260725-135100-child", runDir: "/tmp/20260725-135100-child" });
      return completedResult("20260725-135100-child");
    });
    workflows(harness.pi);
    await harness.commands.get("workflows")!.handler("unexpected", harness.ctx);
    expect(harness.commands.get("workflow-continue")?.getArgumentCompletions?.("20260725")).toEqual([
      expect.objectContaining({ value: actionableRunId }),
    ]);

    await emit(harness, "session_start");
    await waitFor(() => requests.length === 1);

    expect(requests[0]?.continuation?.originRunId).toBe(actionableRunId);
    expect(harness.customComponents).toHaveLength(1);
  });
});
