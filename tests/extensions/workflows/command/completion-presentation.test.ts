import { describe, expect, it } from "vitest";
import {
  createWorkflowTranscript,
  registerWorkflowTranscriptRenderers,
} from "../../../../extensions/workflows/workflow-transcript.js";
import {
  persistCommandWorkflowTranscript,
  WORKFLOW_RESULT_CUSTOM_TYPE,
  WORKFLOW_RUN_CUSTOM_TYPE,
} from "../../../../extensions/workflows/command/receipts.js";
import { createHarness } from "../../../test-harness.js";

const primaryFilePath = "/repo/tmp/plan with spaces/plan.md";
const workspaceDir = "/repo/tmp/plan with spaces";
const nextAction =
  "After the owner reviews and explicitly approves the plan, implement /repo/tmp/plan with spaces/plan.md using the /repo/tmp/plan with spaces/step-<n>.md files, one task/implement run per step file, giving each run only the step id such as S1.";

describe("workflow completion presentation", () => {
  it("ends the TUI on the exact result with primary path, grouped metadata, and gated next action", async () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-tui", "/repo/.pi/locus-pi/runs/run-plan-tui");
    const completion = transcript.finish({
      runId: "run-plan-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-plan-tui",
      ok: true,
      result: "Planning complete. Nothing was implemented.",
      resultTextPath: "/repo/.pi/locus-pi/runs/run-plan-tui/outputs/workflow-result.md",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: { relativePath: "plan.md", absolutePath: primaryFilePath, sha256: "abc123", bytes: 42 },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-plan-tui/runtime/result.json" },
    });

    expect(completion.digest).not.toContain("Planning complete. Nothing was implemented.");
    expect(completion.digest).not.toContain("workspace reuse:");
    expect(completion.digest.indexOf("Files")).toBeLessThan(completion.digest.indexOf("Commands"));
    expect(completion.digest.indexOf("primary file:")).toBeLessThan(completion.digest.indexOf("workspace:"));
    expect(completion.digest).not.toContain("execute.workflow.mjs");
    expect(completion.nextAction).toBe(nextAction);

    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages.map((entry) => entry.message.details?.eventKind)).toEqual([
      "workflow_end",
      "workflow_result",
    ]);
    expect(harness.sentMessages[1]?.message.details).toMatchObject({ primaryFilePath, nextAction });

    const renderer = harness.messageRenderers.get(WORKFLOW_RESULT_CUSTOM_TYPE)!;
    const rendered = renderer(
      harness.sentMessages[1]!.message,
      { expanded: true, outputPad: 0 },
      { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    )
      ?.render(220)
      .join("\n");
    expect(rendered).toContain(`Workflow result (${primaryFilePath})`);
    expect(rendered).toContain("Next action (after review and approval)");
    expect(rendered).toContain("one task/implement run per step file");
  });

  it("labels the task/script result with the generated script's explicit run command", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "task/script", "command");
    transcript.start("run-script-tui", "/repo/.pi/locus-pi/runs/run-script-tui");
    const completion = transcript.finish({
      runId: "run-script-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-script-tui",
      ok: true,
      result: "The execute script is rendered and nothing has been executed.",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: {
        relativePath: "execute.workflow.mjs",
        absolutePath: "/repo/tmp/plan with spaces/execute.workflow.mjs",
        sha256: "def456",
        bytes: 99,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-script-tui/runtime/result.json" },
    });

    expect(completion.digest).toContain(
      'run generated script: /workflows run "/repo/tmp/plan with spaces/execute.workflow.mjs"',
    );
    expect(completion.nextAction).toContain("rendering is not approval to run");
  });

  it("keeps workflow_end last for non-interactive protocol callers", async () => {
    const harness = createHarness();
    harness.ctx.mode = "json";
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-json", "/tmp/run-plan-json");
    const completion = transcript.finish({
      runId: "run-plan-json",
      runDir: "/tmp/run-plan-json",
      ok: true,
      result: "Plan ready",
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-plan-json/runtime/result.json" },
    });

    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages.map((entry) => entry.message.details?.eventKind)).toEqual([
      "workflow_result",
      "workflow_end",
    ]);
    expect(harness.sentMessages.at(-1)?.message.customType).toBe(WORKFLOW_RUN_CUSTOM_TYPE);
  });
});
