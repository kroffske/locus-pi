import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindWorkflowHandoffClaim,
  claimWorkflowOperatorHandoff,
  createWorkflowOperatorHandoffEnvelope,
  readCurrentWorkflowScriptIdentity,
  readWorkflowHandoffClaim,
  type WorkflowOperatorHandoffEnvelope,
} from "../../../extensions/workflows/runtime/workflow-handoff.js";
import { resolveWorkflowTarget } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { WorkflowOperatorHandoffController } from "../../../extensions/workflows/operator-handoff-controller.js";
import { createWorkflowOperatorHandoffService } from "../../../extensions/workflows/operator-handoff-service.js";
import type { WorkflowCommandLaunchResult } from "../../../extensions/workflows/workflow-command-launcher.js";
import { createHarness } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithHandoff(runId: string, existingRoot?: string): string {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), "workflow-handoff-service-"));
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
    snapshotPath: path.join(root, ".pi", "locus-pi", "workflows", runId, "script.workflow.mjs"),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinImports: [],
    unboundDependencies: [],
  };
  const artifactRef = { runId, artifactId: "intent", name: "intent.md", sha256: "0".repeat(64) };
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
  const runDir = path.join(root, ".pi", "locus-pi", "workflows", runId);
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

function corruptHandoff(root: string, runId: string): void {
  const resultPath = path.join(root, ".pi", "locus-pi", "workflows", runId, "result.json");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  result.operatorHandoff = { ...(result.operatorHandoff as Record<string, unknown>), title: 42 };
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
}

describe("workflow operator handoff service", () => {
  it("preserves invalid durable scan evidence", () => {
    const runId = "20260725-140000-invalid";
    const root = projectWithHandoff(runId);
    corruptHandoff(root, runId);
    const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });

    expect(service.scan(root)).toEqual([
      {
        status: "invalid",
        runId,
        message: expect.stringContaining("operatorHandoff title"),
      },
    ]);
  });

  it("lets valid actionable evidence win over malformed history", async () => {
    const malformedRunId = "20260725-141000-malformed";
    const actionableRunId = "20260725-142000-actionable";
    const root = projectWithHandoff(malformedRunId);
    corruptHandoff(root, malformedRunId);
    projectWithHandoff(actionableRunId, root);
    const launch = vi.fn(() => ({ status: "started" as const }));
    const service = createWorkflowOperatorHandoffService({ launch });
    const controller = new WorkflowOperatorHandoffController(service);
    const harness = createHarness(root);
    harness.customInputQueue.push("\r");

    await expect(controller.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: actionableRunId,
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        continuation: expect.objectContaining({ originRunId: actionableRunId }),
      }),
    );
  });

  it.each([
    [{ status: "busy", owner: "active-run" } satisfies WorkflowCommandLaunchResult, "busy"],
    [{ status: "stale" } satisfies WorkflowCommandLaunchResult, "failed"],
  ])("releases its claim when the shared launcher returns $status", async (launchResult, expectedStatus) => {
    const runId = `20260725-14300${expectedStatus === "busy" ? "0" : "1"}-release`;
    const root = projectWithHandoff(runId);
    const launch = vi.fn(() => launchResult);
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toMatchObject({
      status: expectedStatus,
    });
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toEqual({ status: "absent" });
  });

  it("releases an unbound claim when the shared launcher throws before returning", async () => {
    const runId = "20260725-143002-throw-release";
    const root = projectWithHandoff(runId);
    const launch = vi.fn((): WorkflowCommandLaunchResult => {
      throw new Error("launcher exploded");
    });
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toEqual({
      status: "failed",
      message: "Workflow continuation launch failed before start: launcher exploded",
    });
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toEqual({ status: "absent" });
    expect(service.scan(root)).toContainEqual({ status: "actionable", handoff: item.handoff, state: "pending" });
  });

  it("reports both launch and claim-release failures without hiding the durable claim", async () => {
    const runId = "20260725-143003-throw-release-failure";
    const root = projectWithHandoff(runId);
    const claimLockPath = path.join(root, ".pi", "locus-pi", "workflows", runId, "operator-handoff-claim.lock");
    const launch = vi.fn((): WorkflowCommandLaunchResult => {
      writeFileSync(claimLockPath, "active\n", "utf8");
      throw new Error("launcher exploded");
    });
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toEqual({
      status: "failed",
      message:
        "Workflow continuation launch failed before start: launcher exploded Its unbound claim could not be released: Workflow handoff claim transition is active.",
    });
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toMatchObject({ status: "ready" });
  });

  it("distinguishes a never-answered handoff from one whose continuation failed", () => {
    const runId = "20260725-145000-retry-state";
    const childRunId = "20260725-145100-failed-child";
    const root = projectWithHandoff(runId);
    const service = createWorkflowOperatorHandoffService({ launch: vi.fn() });

    expect(service.scan(root)).toContainEqual(expect.objectContaining({ status: "actionable", state: "pending" }));

    const claimed = claimWorkflowOperatorHandoff(
      root,
      (service.scan(root)[0] as { handoff: { value: WorkflowOperatorHandoffEnvelope } }).handoff.value,
    );
    if (claimed.status !== "claimed") throw new Error("expected a claimed handoff");
    bindWorkflowHandoffClaim(claimed.claim, childRunId);
    const childRunDir = path.join(root, ".pi", "locus-pi", "workflows", childRunId);
    mkdirSync(childRunDir, { recursive: true });
    writeFileSync(
      path.join(childRunDir, "result.json"),
      `${JSON.stringify({
        runId: childRunId,
        ok: false,
        disposition: { status: "failed" },
        journal: [],
        resultPersistence: { ok: true, path: path.join(childRunDir, "result.json") },
        error: "plan was not accepted",
      })}\n`,
      "utf8",
    );

    const items = service.scan(root).filter((entry) => entry.status === "actionable");
    expect(items).toContainEqual(expect.objectContaining({ status: "actionable", state: "retryable" }));
    expect(items).not.toContainEqual(expect.objectContaining({ state: "pending" }));
  });

  it("rejects target script drift before claiming or launching", async () => {
    const runId = "20260725-144000-drift";
    const root = projectWithHandoff(runId);
    const launch = vi.fn(() => ({ status: "started" as const }));
    const service = createWorkflowOperatorHandoffService({ launch });
    const item = service.scan(root).find((entry) => entry.status === "actionable");
    if (item?.status !== "actionable") throw new Error("expected actionable handoff");
    writeFileSync(
      path.join(root, ".pi", "workflows", "alpha.workflow.mjs"),
      'export const meta={name:"alpha",description:"Changed"}; export default async()=>({ok:false});\n',
      "utf8",
    );
    const harness = createHarness(root);

    await expect(service.launch(item.handoff, "Current changes", harness.ctx)).resolves.toMatchObject({
      status: "invalid",
      message: expect.stringContaining("script identity has changed"),
    });
    expect(launch).not.toHaveBeenCalled();
    expect(readWorkflowHandoffClaim(root, item.handoff.value)).toEqual({ status: "absent" });
  });
});
