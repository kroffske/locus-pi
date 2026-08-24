import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNewWorkflowRun,
  workflowJournalFile,
  workflowRunDir,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * A run id is a second-resolution timestamp plus a 16-bit random suffix, so two
 * runs starting in the same second can mint the same id. The exclusive journal
 * create is the claim; a lost claim must retry with a FRESH id, never crash.
 */

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-id-"));
  roots.push(root);
  return root;
}

const sameSecond = () => new Date("2026-08-23T00:02:30.453Z");

function prelude(runId: string): WorkflowJournalLine {
  return { ts: sameSecond().toISOString(), runId, kind: "log", source: "runtime", message: "prelude" };
}

describe("claimNewWorkflowRun", () => {
  it("retries with a fresh id when the minted id is already claimed", () => {
    const root = temporaryProject();
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0x4560 / 0x10000);
    const first = claimNewWorkflowRun(root, prelude, sameSecond);
    expect(first.runId).toBe("20260823-000230-4560");

    // The second claim draws the same suffix in the same second, then a fresh one.
    random.mockReturnValueOnce(0x4560 / 0x10000).mockReturnValueOnce(0x9c1d / 0x10000);
    const second = claimNewWorkflowRun(root, prelude, sameSecond);
    expect(second.runId).toBe("20260823-000230-9c1d");

    for (const claimed of [first, second]) {
      expect(claimed.firstLine.runId).toBe(claimed.runId);
      expect(existsSync(workflowJournalFile(workflowRunDir(root, claimed.runId)))).toBe(true);
    }
  });

  it("gives up with a clear diagnostic when every minted id is already claimed", () => {
    const root = temporaryProject();
    vi.spyOn(Math, "random").mockReturnValue(0x4560 / 0x10000);
    claimNewWorkflowRun(root, prelude, sameSecond);
    expect(() => claimNewWorkflowRun(root, prelude, sameSecond)).toThrow(/unique workflow run id after 5 attempts/u);
  });
});
