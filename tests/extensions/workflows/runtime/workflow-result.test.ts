import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
  WORKFLOW_FINALIZATION_ERROR_MAX_CHARS,
  WORKFLOW_RESULT_NOT_JSON_SAFE,
  WORKFLOW_RESULT_WRITE_FAILED,
  classifyWorkflowReturnedFailure,
  formatWorkflowResultDetail,
  formatWorkflowFailureSummary,
  formatWorkflowResultSummary,
  isWorkflowResultExplicitFailure,
  prepareWorkflowResult,
  projectWorkflowDisposition,
  workflowDispositionForCompletion,
  workflowFinalizationError,
  workflowResultFile,
  writeWorkflowResultJson,
} from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  ensureWorkflowRunDir,
  workflowRunRuntimeDir,
} from "../../../../extensions/workflows/runtime/workflow-run-layout.js";

describe("workflow result JSON boundary", () => {
  it("bounds typed finalization errors without changing their stage", () => {
    const exact = workflowFinalizationError("report", "report failed");
    expect(exact).toEqual({ stage: "report", message: "report failed" });

    const bounded = workflowFinalizationError("lease-release", "x".repeat(2000));
    expect(bounded.stage).toBe("lease-release");
    expect(bounded.message).toHaveLength(WORKFLOW_FINALIZATION_ERROR_MAX_CHARS);
    expect(bounded.message).toMatch(/truncated/u);
  });

  it("projects new dispositions strictly while preserving only absent legacy envelopes", () => {
    expect(projectWorkflowDisposition({ ok: true, result: { summary: "legacy" } })).toEqual({
      status: "completed",
      summary: "legacy",
    });
    expect(projectWorkflowDisposition({ ok: false, result: null, error: "legacy failed" })).toEqual({
      status: "failed",
      summary: "legacy failed",
    });
    expect(
      projectWorkflowDisposition({
        ok: true,
        result: { mode: "prepared" },
        disposition: { status: "awaiting_operator", detail: "review clarification required" },
      }),
    ).toEqual({
      status: "awaiting_operator",
      summary: "awaiting operator · review clarification required",
    });
    expect(
      projectWorkflowDisposition({
        ok: false,
        result: null,
        disposition: { status: "cancelled", reason: "operator_stop" },
      }),
    ).toEqual({ status: "cancelled", summary: "cancelled by operator" });
    expect(
      projectWorkflowDisposition({
        ok: true,
        result: "would otherwise look successful",
        disposition: { status: "future_status" },
      }),
    ).toEqual({ status: "unknown", summary: "unknown workflow disposition" });
    expect(
      projectWorkflowDisposition({
        ok: true,
        result: "inconsistent",
        disposition: { status: "failed" },
      }),
    ).toEqual({ status: "unknown", summary: "unknown workflow disposition" });
  });

  it("gives controlling abort signals precedence over waiting and success", () => {
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: true,
        abortReason: { kind: "operator_stop" },
        awaitOperatorReason: "questions remain",
      }),
    ).toEqual({ status: "cancelled", reason: "operator_stop" });
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: true,
        abortReason: { kind: "session_shutdown" },
      }),
    ).toEqual({ status: "cancelled", reason: "session_shutdown" });
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: false,
        awaitOperatorReason: "questions remain",
      }),
    ).toEqual({ status: "awaiting_operator", detail: "questions remain" });
    expect(
      workflowDispositionForCompletion({
        ok: true,
        aborted: false,
        awaitOperatorReason: "x".repeat(201),
      }),
    ).toEqual({ status: "failed" });
  });

  it("classifies one returned-outcome failure policy for root and grouped execution", () => {
    expect(classifyWorkflowReturnedFailure({ ok: false, status: "blocked", summary: "stopped" })).toEqual({
      kind: "ok-false",
      status: "blocked",
      summary: "stopped",
    });
    expect(classifyWorkflowReturnedFailure({ partial: true })).toEqual({ kind: "partial" });
    expect(classifyWorkflowReturnedFailure({ status: "failed" })).toEqual({ kind: "status", status: "failed" });
    expect(classifyWorkflowReturnedFailure({ status: "blocked" })).toEqual({ kind: "status", status: "blocked" });
    expect(classifyWorkflowReturnedFailure({ status: "cancelled" })).toEqual({
      kind: "status",
      status: "cancelled",
    });
    expect(classifyWorkflowReturnedFailure({ status: "completed" })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure({ ok: true, partial: false })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure({ ok: "false", partial: "true" })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure({ summary: "legacy success" })).toBeUndefined();
    expect(classifyWorkflowReturnedFailure(null)).toBeUndefined();

    expect(isWorkflowResultExplicitFailure({ ok: false })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ partial: true })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ status: "blocked" })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ status: "completed" })).toBe(false);
  });

  it("formats semantic failures with stable unresolved ids while technical errors retain priority", () => {
    const result = {
      ok: false,
      summary: "Acceptance remains open",
      unresolvedRows: [" R-GIT ", "R-CODE", "R-GIT", ""],
    };

    expect(formatWorkflowFailureSummary(result)).toBe("Acceptance remains open · unresolved: R-CODE, R-GIT");
    expect(formatWorkflowFailureSummary(result, " transport failed ")).toBe("transport failed");
    expect(formatWorkflowFailureSummary({ ok: false })).toBe("Workflow execution failed.");
  });

  it("preserves null but replaces undefined, BigInt, circular, and throwing toJSON results with an explicit sentinel", () => {
    const circular: Record<string, unknown> = { label: "cycle" };
    circular.self = circular;
    const throwingToJson = {
      toJSON(): never {
        throw new Error("toJSON refused");
      },
    };
    const throwingSummary: Record<string, unknown> = {};
    Object.defineProperty(throwingSummary, "summary", {
      enumerable: true,
      get(): never {
        throw new Error("summary getter refused");
      },
    });

    expect(prepareWorkflowResult(null)).toEqual({ value: null });
    expect(formatWorkflowResultSummary(null)).toBe("completed");
    expect(formatWorkflowResultDetail(null)).toBe("null");

    for (const unsafe of [undefined, 42n, circular, throwingToJson, throwingSummary]) {
      const prepared = prepareWorkflowResult(unsafe);
      expect(prepared.diagnostic).toMatchObject({
        kind: "workflow_result_diagnostic",
        code: WORKFLOW_RESULT_NOT_JSON_SAFE,
        message: expect.stringContaining("not JSON-safe"),
      });
      expect(prepared.value).toEqual(prepared.diagnostic);
      expect(() => formatWorkflowResultSummary(unsafe)).not.toThrow();
      expect(formatWorkflowResultSummary(unsafe)).toBe("result unavailable");
      const detail = formatWorkflowResultDetail(unsafe, 200);
      expect(detail.length).toBeLessThanOrEqual(200);
      expect(detail).toContain("WORKFLOW_RESULT_NOT_JSON_SAFE");
    }
  });

  it("reports both envelope serialization and filesystem write failures instead of swallowing them", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-result-boundary-"));
    try {
      const safeDir = ensureWorkflowRunDir(root, "safe");
      const safe = writeWorkflowResultJson(safeDir, { runId: "safe", ok: true, result: null });
      expect(safe).toEqual({ ok: true, path: workflowResultFile(safeDir) });
      expect(JSON.parse(readFileSync(safe.path, "utf8"))).toMatchObject({ runId: "safe", result: null });

      const unsafeDir = ensureWorkflowRunDir(root, "unsafe");
      const unsafe = writeWorkflowResultJson(unsafeDir, { runId: "unsafe", ok: true, result: 42n });
      expect(unsafe).toMatchObject({ ok: false, code: WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE });
      expect(existsSync(workflowResultFile(unsafeDir))).toBe(false);

      const blockedDir = ensureWorkflowRunDir(root, "blocked");
      rmSync(workflowRunRuntimeDir(blockedDir), { recursive: true });
      writeFileSync(workflowRunRuntimeDir(blockedDir), "not a directory", "utf8");
      const blocked = writeWorkflowResultJson(blockedDir, { runId: "blocked", ok: true, result: null });
      expect(blocked).toMatchObject({ ok: false, code: WORKFLOW_RESULT_WRITE_FAILED });
      if (blocked.ok) throw new Error("expected blocked persistence to fail");
      expect(blocked.message).toContain("not persisted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
