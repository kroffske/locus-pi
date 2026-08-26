import { describe, expect, it } from "vitest";
import {
  createWorkflowTranscript,
  registerWorkflowTranscriptRenderers,
} from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import {
  persistCommandWorkflowTranscript,
  WORKFLOW_RESULT_CUSTOM_TYPE,
  WORKFLOW_RUN_CUSTOM_TYPE,
} from "../../../../extensions/workflows/command/receipts.js";
import { createHarness } from "../../../test-harness.js";

const primaryFilePath = "/repo/tmp/plan with spaces/plan.md";
const workspaceDir = "/repo/tmp/plan with spaces";
const nextAction =
  'After the owner reviews and explicitly approves /repo/tmp/plan with spaces/plan.md and the /repo/tmp/plan with spaces/step-<n>.md files, render the complete implementation plan with the same workspace: /workflows run task/implement-plan-template --output-dir "tmp/plan with spaces". Review the generated implement-plan.workflow.mjs before running it by explicit path.';

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
    expect(rendered).toContain("task/implement-plan-template");
  });

  // The digest is plain by contract — it enters model context and the session
  // JSONL. Tone belongs to the card that draws it, and to nothing else.
  it("paints the finished card's group labels and status markers without touching the digest text", async () => {
    const harness = createHarness();
    registerWorkflowTranscriptRenderers(harness.pi);
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-tone", "/repo/.pi/locus-pi/runs/run-plan-tone");
    const completion = transcript.finish({
      runId: "run-plan-tone",
      runDir: "/repo/.pi/locus-pi/runs/run-plan-tone",
      ok: true,
      result: "Planning complete.",
      resultTextPath: "/repo/.pi/locus-pi/runs/run-plan-tone/outputs/workflow-result.md",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: { relativePath: "plan.md", absolutePath: primaryFilePath, sha256: "abc123", bytes: 42 },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-plan-tone/runtime/result.json" },
    });

    expect(completion.digest).toContain("\nFiles\n");
    expect(completion.digest).not.toMatch(/<(?:accent|success|error|warning)>/u);
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    const runMessage = harness.sentMessages.find(
      (entry) =>
        entry.message.customType === WORKFLOW_RUN_CUSTOM_TYPE && entry.message.details?.eventKind === "workflow_end",
    )!;
    const rendered = harness.messageRenderers.get(WORKFLOW_RUN_CUSTOM_TYPE)!(
      runMessage.message,
      { expanded: true, outputPad: 0 },
      {
        fg: (color, text) => `<${color}>${text}</${color}>`,
        bg: (_color, text) => text,
        bold: (text) => `*${text}*`,
      },
    )
      ?.render(220)
      .join("\n");

    expect(rendered).toContain("<accent>*Workflow finished*</accent>");
    expect(rendered).toContain("<accent>*Files*</accent>");
    expect(rendered).toContain("<accent>*Commands*</accent>");
    expect(rendered).toContain("<success>✓</success> workflow task/plan finished");
    // Only the marker is tinted — the sentence after it stays the digest's own text.
    expect(rendered).toContain("primary file: /repo/tmp/plan with spaces/plan.md");
  });

  it("labels the implement-plan template result with the generated script's explicit run command", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "task/implement-plan-template", "command");
    transcript.start("run-script-tui", "/repo/.pi/locus-pi/runs/run-script-tui");
    const completion = transcript.finish({
      runId: "run-script-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-script-tui",
      ok: true,
      result: "Planning and rendering are complete and nothing has been executed.",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: {
        relativePath: "implement-plan.workflow.mjs",
        absolutePath: "/repo/tmp/plan with spaces/implement-plan.workflow.mjs",
        sha256: "def456",
        bytes: 99,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-script-tui/runtime/result.json" },
    });

    expect(completion.digest).toContain(
      'run generated script: /workflows run "/repo/tmp/plan with spaces/implement-plan.workflow.mjs" --output-dir "tmp/plan with spaces"',
    );
    expect(completion.nextAction).toContain("rendering is not approval to run");
  });

  it("hands a completed task draft to task/plan on the exact same workspace", () => {
    const harness = createHarness();
    const planningWorkspace = ".locus-pi/plans/20260819-120000-a1b2-task-draft";
    const transcript = createWorkflowTranscript(harness.ctx, "task/draft", "command");
    transcript.start("run-draft-tui", "/repo/.pi/locus-pi/runs/run-draft-tui");
    const completion = transcript.finish({
      runId: "run-draft-tui",
      runDir: "/repo/.pi/locus-pi/runs/run-draft-tui",
      ok: true,
      result: "Task drafting is complete.",
      workspaceDir: `/repo/${planningWorkspace}`,
      workspaceDirRelative: planningWorkspace,
      primaryFile: {
        relativePath: "draft.md",
        absolutePath: `/repo/${planningWorkspace}/draft.md`,
        sha256: "abc123",
        bytes: 120,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-draft-tui/runtime/result.json" },
    });

    expect(completion.nextAction).toContain("/workflows run task/plan --run-name 20260819-120000-a1b2-task-draft");
    expect(completion.digest).toContain("/workflows run task/plan --run-name 20260819-120000-a1b2-task-draft");
    expect(completion.nextAction).toContain("Planning reuses this exact workspace");
    expect(completion.nextAction).not.toContain("/workflows run task/implement --");
  });

  it("hands a named completed plan to the template renderer with the same run name", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "tool");
    const workspace = ".locus-pi/plans/airflow-builder";
    transcript.start("run-plan-named", "/repo/.locus-pi/runs/run-plan-named");
    const completion = transcript.finish({
      runId: "run-plan-named",
      runDir: "/repo/.locus-pi/runs/run-plan-named",
      ok: true,
      result: "Plan ready.",
      workspaceDir: `/repo/${workspace}`,
      workspaceDirRelative: workspace,
      primaryFile: {
        relativePath: "plan.md",
        absolutePath: `/repo/${workspace}/plan.md`,
        sha256: "abc123",
        bytes: 120,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.locus-pi/runs/run-plan-named/runtime/result.json" },
    });

    expect(completion.nextAction).toContain("/workflows run task/implement-plan-template --run-name airflow-builder");
    expect(completion.digest).toContain("/workflows run task/implement-plan-template --run-name airflow-builder");
    expect(completion.nextAction).not.toContain("-- S1");
  });

  it("routes a fail-closed planning blocker to a rerun instruction instead of an implement handoff", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "task/plan", "command");
    transcript.start("run-plan-blocked", "/repo/.pi/locus-pi/runs/run-plan-blocked");
    const completion = transcript.finish({
      runId: "run-plan-blocked",
      runDir: "/repo/.pi/locus-pi/runs/run-plan-blocked",
      ok: true,
      result: "Planning finished BLOCKED and nothing has been implemented.",
      workspaceDir,
      workspaceDirRelative: "tmp/plan with spaces",
      primaryFile: {
        relativePath: "planning-blocker.md",
        absolutePath: "/repo/tmp/plan with spaces/planning-blocker.md",
        sha256: "0ff1ce",
        bytes: 17,
      },
      journal: [],
      resultPersistence: { ok: true, path: "/repo/.pi/locus-pi/runs/run-plan-blocked/runtime/result.json" },
    });

    expect(completion.digest).not.toContain("run generated script:");
    expect(completion.nextAction).toContain("Planning failed closed");
    expect(completion.nextAction).toContain('/workflows run task/plan --output-dir "tmp/plan with spaces"');
    expect(completion.nextAction).not.toContain("task/implement-plan-template");
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
