import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
  WORKFLOW_RESULT_NOT_JSON_SAFE,
  WORKFLOW_RESULT_WRITE_FAILED,
  formatWorkflowResultDetail,
  formatWorkflowFailureSummary,
  formatWorkflowResultSummary,
  isWorkflowResultExplicitFailure,
  prepareWorkflowResult,
  projectWorkflowDisposition,
  workflowDispositionForCompletion,
  workflowResultFile,
  writeWorkflowResultJson,
} from "../../../extensions/workflows/runtime/workflow-result.js";

describe("workflow result JSON boundary", () => {
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

  it("treats explicit ok:false and partial:true as semantic non-success", () => {
    expect(isWorkflowResultExplicitFailure({ ok: false, summary: "stopped" })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ partial: true })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ ok: true, partial: true })).toBe(true);
    expect(isWorkflowResultExplicitFailure({ ok: true })).toBe(false);
    expect(isWorkflowResultExplicitFailure({ ok: true, partial: false })).toBe(false);
    expect(isWorkflowResultExplicitFailure({ ok: "false" })).toBe(false);
    expect(isWorkflowResultExplicitFailure({ partial: "true" })).toBe(false);
    expect(isWorkflowResultExplicitFailure({ summary: "legacy success" })).toBe(false);
    expect(isWorkflowResultExplicitFailure(null)).toBe(false);
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
      const safeDir = path.join(root, "safe");
      const safe = writeWorkflowResultJson(safeDir, { runId: "safe", ok: true, result: null });
      expect(safe).toEqual({ ok: true, path: workflowResultFile(safeDir) });
      expect(JSON.parse(readFileSync(safe.path, "utf8"))).toMatchObject({ runId: "safe", result: null });

      const unsafeDir = path.join(root, "unsafe");
      const unsafe = writeWorkflowResultJson(unsafeDir, { runId: "unsafe", ok: true, result: 42n });
      expect(unsafe).toMatchObject({ ok: false, code: WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE });
      expect(existsSync(workflowResultFile(unsafeDir))).toBe(false);

      const blockedDir = path.join(root, "blocked");
      writeFileSync(blockedDir, "not a directory", "utf8");
      const blocked = writeWorkflowResultJson(blockedDir, { runId: "blocked", ok: true, result: null });
      expect(blocked).toMatchObject({ ok: false, code: WORKFLOW_RESULT_WRITE_FAILED });
      if (blocked.ok) throw new Error("expected blocked persistence to fail");
      expect(blocked.message).toContain("not persisted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
