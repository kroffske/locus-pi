import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  buildWorkflowFailureDiagnostic,
  formatWorkflowFailureDiagnosticLines,
  parseWorkflowFailureDiagnostic,
} from "../../../../extensions/workflows/runtime/workflow-failure.js";
import {
  readWorkflowRunResult,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../../test-harness.js";

function journal(runId: string, phases: readonly string[]): WorkflowJournalLine[] {
  return phases.map((phase, index) => ({
    ts: `2026-01-01T00:00:0${index}.000Z`,
    runId,
    kind: "phase",
    phase,
  })) as WorkflowJournalLine[];
}

describe("workflow failure diagnostic", () => {
  it("names the failing stage, owning script, and the answer that stage produced", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/.pi/locus-pi/runs/run-1",
      journalPath: "/repo/.pi/locus-pi/runs/run-1/journal.ndjson",
      journal: journal("run-1", ["resolve-scope", "inventory-changes"]),
      origin: "script",
      error: "review inventory returned neither a coverage entry nor the declaration",
      target: { ref: "review" },
      scriptIdentity: { sourcePath: "/repo/extensions/workflows/examples/review/review.workflow.mjs" },
      // Exactly the shape the artifact store records: relative to the run's
      // artifacts directory, so the pointer must resolve under runtime/artifacts.
      artifacts: [
        { kind: "answer", stage: "resolve-scope", relativePath: "answers/call-0002-scope.md.md" },
        { kind: "answer", stage: "inventory-changes", relativePath: "answers/call-0003-inventory.md.md" },
        { kind: "published", stage: "resolve-scope", relativePath: "published/published-0001-intent.md" },
      ],
    });

    expect(diagnostic).toEqual({
      origin: "script",
      message: "review inventory returned neither a coverage entry nor the declaration",
      stage: "inventory-changes",
      workflow: "review",
      scriptPath: "extensions/workflows/examples/review/review.workflow.mjs",
      evidencePath: ".pi/locus-pi/runs/run-1/runtime/artifacts/answers/call-0003-inventory.md.md",
      journalPath: ".pi/locus-pi/runs/run-1/journal.ndjson",
      repairRequest:
        'Fix the "review" workflow: its script rejected the run at stage "inventory-changes" — review inventory ' +
        "returned neither a coverage entry nor the declaration. " +
        "Script: extensions/workflows/examples/review/review.workflow.mjs. " +
        "Failing stage answer: .pi/locus-pi/runs/run-1/runtime/artifacts/answers/call-0003-inventory.md.md. " +
        "Run journal: .pi/locus-pi/runs/run-1/journal.ndjson.",
    });
    // The repair request survives a round trip through result.json unchanged.
    expect(parseWorkflowFailureDiagnostic(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic);
  });

  it("states what it cannot prove instead of guessing a stage, script, or answer", () => {
    const diagnostic = buildWorkflowFailureDiagnostic({
      projectRoot: "/repo",
      runDir: "/repo/.pi/locus-pi/runs/run-2",
      journalPath: "/repo/.pi/locus-pi/runs/run-2/journal.ndjson",
      journal: [],
      error: "  Pi SDK host: connection refused  ",
    });

    expect(diagnostic.origin).toBe("runtime");
    expect(diagnostic).not.toHaveProperty("stage");
    expect(diagnostic).not.toHaveProperty("scriptPath");
    expect(diagnostic).not.toHaveProperty("evidencePath");
    expect(diagnostic.repairRequest).toBe(
      "Diagnose this workflow: the workflow runtime failed — Pi SDK host: connection refused. " +
        "Run journal: .pi/locus-pi/runs/run-2/journal.ndjson.",
    );
    expect(formatWorkflowFailureDiagnosticLines(diagnostic)).toEqual([
      "journal: .pi/locus-pi/runs/run-2/journal.ndjson",
    ]);
    expect(formatWorkflowFailureDiagnosticLines(diagnostic, { repairRequest: true }).at(-1)).toBe(
      `copy: ${diagnostic.repairRequest}`,
    );
  });

  it("rejects a persisted diagnostic that lost a required field", () => {
    expect(parseWorkflowFailureDiagnostic({ origin: "script", message: "x", journalPath: "j" })).toBeUndefined();
    expect(
      parseWorkflowFailureDiagnostic({ origin: "guess", message: "x", journalPath: "j", repairRequest: "r" }),
    ).toBeUndefined();
    expect(parseWorkflowFailureDiagnostic("failed")).toBeUndefined();
  });

  it("attaches the diagnostic to a thrown script run, persists it, and reads it back", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-failure-diagnostic-"));
    const harness = createHarness(root, { sessionId: "wf-failure-diagnostic" });
    try {
      writeFileSync(
        path.join(root, "boom.workflow.mjs"),
        [
          "export const meta = { name: 'boom', description: 'throws in a declared stage' };",
          "export default async function run({ agent, phase }) {",
          "  phase('inventory-changes');",
          "  await agent('inventory the changes', { label: 'inventory' });",
          "  throw new Error('inventory answer does not follow its prompt');",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "boom.workflow.mjs",
        createExecutor: () => ({
          async run(request: AgentRunRequest) {
            return {
              status: "completed" as const,
              agentName: request.agent?.name ?? "sub-agent",
              reason: "answered",
              text: "inventory: two files changed",
              diagnostics: [],
              lifecycleEntryIds: [],
            };
          },
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.failureDiagnostic).toMatchObject({
        origin: "script",
        message: "inventory answer does not follow its prompt",
        stage: "inventory-changes",
        workflow: "boom.workflow.mjs",
        scriptPath: "boom.workflow.mjs",
      });
      expect(result.failureDiagnostic?.journalPath).toContain(result.runId);
      // The pointer is only useful if it opens. Asserting the string shape alone
      // is how a two-segment path error survived: the producer writes the answer
      // relative to the artifacts directory, and the diagnostic must say so.
      const evidencePath = result.failureDiagnostic?.evidencePath;
      expect(evidencePath).toBeDefined();
      expect(existsSync(path.resolve(root, evidencePath ?? ""))).toBe(true);
      expect(readFileSync(path.resolve(root, evidencePath ?? ""), "utf8")).toContain("inventory: two files changed");
      expect(result.failureDiagnostic?.repairRequest).toContain('Fix the "boom.workflow.mjs" workflow');
      expect(result.failureDiagnostic?.repairRequest).toContain("Script: boom.workflow.mjs");

      const persisted = JSON.parse(readFileSync(result.resultPersistence.path, "utf8")) as {
        failureDiagnostic?: unknown;
      };
      expect(persisted.failureDiagnostic).toEqual(result.failureDiagnostic);
      expect(readWorkflowRunResult(root, result.runId)?.failureDiagnostic).toEqual(result.failureDiagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves deliberate returned-outcome failures without a repair request", async () => {
    const cases = [
      { name: "ok-false", expression: "{ ok: false, summary: 'Acceptance remains open' }" },
      { name: "blocked", expression: "{ status: 'blocked', summary: 'Owner decision required' }" },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(path.join(tmpdir(), `wf-semantic-${testCase.name}-`));
      const harness = createHarness(root, { sessionId: `wf-semantic-${testCase.name}` });
      try {
        writeFileSync(
          path.join(root, "verdict.workflow.mjs"),
          `export default () => (${testCase.expression});\n`,
          "utf8",
        );
        const result = await runWorkflowScript({
          pi: harness.pi,
          ctx: harness.ctx,
          signal: new AbortController().signal,
          scriptPath: "verdict.workflow.mjs",
        });

        expect(result.ok, testCase.name).toBe(false);
        expect(result.error, testCase.name).toBeUndefined();
        expect(result.failureDiagnostic, testCase.name).toBeUndefined();
        expect(readWorkflowRunSummary(root, result.runId).status, testCase.name).toBe("failed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
