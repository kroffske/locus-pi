import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("shipped workflow run skill", () => {
  it("routes by host capability and treats typed receipts as workflow truth", () => {
    const runSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-run/SKILL.md"), "utf8");
    const authoringSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-create/SKILL.md"), "utf8");

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
    expect(authoringSkill).toContain("`locus-pi-workflow-run` skill");
  });

  it("keeps provider, model, and role selection operator-owned", () => {
    const runSkill = readFileSync(path.join(root, "skills/locus-pi-workflow-run/SKILL.md"), "utf8");

    expect(runSkill).toContain("Model choice belongs to the operator");
    expect(runSkill).toContain("pi --list-models");
    expect(runSkill).toContain("pi --list-models <provider>");
    expect(runSkill).toContain("defaultProvider, defaultModel, defaultThinkingLevel, enabledModels");
    expect(runSkill).toContain("~/.pi/agent/model-roles/config.json");
    expect(runSkill).not.toContain("settings.json#modelRoles` as an input");
    expect(runSkill).toContain("must be permitted by `enabledModels`");
    expect(runSkill).toMatch(/preserve the current Pi\s+session and its configured defaults/);
    expect(runSkill).not.toContain("openai-codex");
    expect(runSkill).not.toContain("gpt-5.6");
  });
});
