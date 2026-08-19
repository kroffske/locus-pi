import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("shipped workflow run skill", () => {
  it("routes by host capability and treats typed receipts as workflow truth", () => {
    const runSkill = readFileSync(path.join(root, "skills/locus-pi-run-workflow/SKILL.md"), "utf8");
    const authoringSkill = readFileSync(path.join(root, "skills/locus-pi-workflows/SKILL.md"), "utf8");

    for (const contract of [
      "If a structured tool named `workflow` is available",
      "If the request supplies `items` or `continuation`",
      "stop as unsupported when that tool is unavailable",
      '"pi", "--mode", "json", "-p", "--no-session", "--approve", prompt',
      "`target`, `runName`, `outputDir`, and `resumeFromRunId`",
      "Reject a command-token value",
      "first character is `-`",
      'message.customType == "locus-workflow-run"',
      "workflow_start",
      "workflow_rejected",
      "workflow_end",
      "journalPath",
      "resultPersisted",
      "process exit code alone as semantic success",
      "not sandboxed",
    ]) {
      expect(runSkill, contract).toContain(contract);
    }
    expect(runSkill).not.toContain("locus-pi workflow run");
    expect(runSkill).not.toContain("monitor, or inspect");
    expect(authoringSkill).toContain("Do not use merely to run an existing workflow");
    expect(authoringSkill).toContain("`locus-pi-run-workflow` skill");
  });
});
