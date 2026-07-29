import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import type { WorkflowArtifactRecord } from "../../../extensions/_shared/workflow-artifacts.js";
import {
  workflowReportDir,
  writeWorkflowRunReport,
  type WorkflowRunReportEvidenceSource,
} from "../../../extensions/_shared/workflow-run-report.js";
import { runWorkflowScript } from "../../../extensions/_shared/workflow-runner.js";
import type { WorkflowJournalLine } from "../../../extensions/_shared/workflow-runtime.js";
import { createHarness } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-report-"));
  roots.push(root);
  return root;
}

const RUN_ID = "20260728-190000-abcd";

function record(
  overrides: Partial<WorkflowArtifactRecord> & Pick<WorkflowArtifactRecord, "artifactId" | "name" | "kind">,
): WorkflowArtifactRecord {
  return {
    runId: RUN_ID,
    sha256: "a".repeat(64),
    mediaType: "text/markdown; charset=utf-8",
    size: 1,
    relativePath: path.join("answers", overrides.artifactId),
    provenance: "fresh",
    createdAt: "2026-07-28T19:00:00.000Z",
    ...overrides,
  };
}

function agentLines(callId: string, label: string, phase: string): WorkflowJournalLine[] {
  return [
    { ts: "2026-07-28T19:00:00.000Z", runId: RUN_ID, kind: "agent_start", agent: "default", label, callId, phase },
    {
      ts: "2026-07-28T19:00:01.000Z",
      runId: RUN_ID,
      kind: "agent_end",
      agent: "default",
      label,
      callId,
      phase,
      status: "completed",
    },
  ] as WorkflowJournalLine[];
}

function evidenceFrom(
  records: WorkflowArtifactRecord[],
  bytes: Record<string, string>,
): WorkflowRunReportEvidenceSource {
  return {
    list: () => records,
    read: (ref) => {
      const text = bytes[ref.artifactId];
      if (text === undefined) throw new Error(`unreadable artifact: ${ref.artifactId}`);
      return Buffer.from(text, "utf8");
    },
  };
}

describe("workflow run report", () => {
  it("writes a table of contents, the task, the result, and author-named documents in order", () => {
    const root = project();
    const records = [
      record({ artifactId: "published-0001", name: "task.md", kind: "published" }),
      record({
        artifactId: "call-0001-answer",
        name: "context.md",
        kind: "answer",
        callId: "call-0001",
        stage: "scout-repository",
      }),
      record({
        artifactId: "call-0002-answer",
        name: "plan.md",
        kind: "answer",
        callId: "call-0002",
        stage: "draft-plan",
      }),
      record({
        artifactId: "call-0003-answer",
        name: "plan-critique.json",
        kind: "answer",
        callId: "call-0003",
        stage: "critique-plan",
      }),
      record({ artifactId: "published-0002", name: "questions.md", kind: "published" }),
      record({
        artifactId: "input-0001",
        name: "plan.md",
        kind: "input",
        source: {
          runId: "20260728-180000-prev",
          artifactId: "call-0002-answer",
          name: "plan.md",
          sha256: "b".repeat(64),
        },
      }),
    ];
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        target: { kind: "name", ref: "plan", source: "package" },
        result: "# Accepted plan\n",
        journal: [
          ...agentLines("call-0001", "scout", "scout-repository"),
          ...agentLines("call-0002", "planner round 1", "draft-plan"),
          ...agentLines("call-0003", "critic round 1", "critique-plan"),
        ],
      },
      evidenceFrom(records, {
        "published-0001": "the task text",
        "call-0001-answer": "context body",
        "call-0002-answer": "plan body",
        "call-0003-answer": '{"verdict":"revise","defects":["S2: path is wrong","S5: no verify"]}',
        "published-0002": "questions body",
        "input-0001": "consumed plan",
      }),
    );

    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const reportDir = workflowReportDir(root, RUN_ID);
    const names = readdirSync(reportDir).sort();
    assert.deepEqual(names, [
      "01-scout-context.md",
      "02-planner-round-1-plan.md",
      "03-critic-round-1-plan-critique.md",
      "04-workflow-questions.md",
      "05-input-plan.md",
      "README.md",
      "result.md",
      "task.md",
    ]);
    assert.ok(names.every((name) => !name.endsWith(".md.md")));
    assert.equal(readFileSync(path.join(reportDir, "task.md"), "utf8"), "the task text");
    assert.equal(readFileSync(path.join(reportDir, "result.md"), "utf8"), "# Accepted plan\n");
    assert.equal(readFileSync(path.join(reportDir, "01-scout-context.md"), "utf8"), "context body");
    assert.equal(
      readFileSync(path.join(reportDir, "03-critic-round-1-plan-critique.md"), "utf8"),
      ["- **verdict**: revise", "- **defects**:", "  1. S2: path is wrong", "  2. S5: no verify", ""].join("\n"),
    );

    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Workflow: `plan` \(package\)/u);
    assert.match(readme, /- Status: completed/u);
    assert.match(readme, /- Task: \[task\.md\]\(task\.md\)/u);
    assert.match(readme, /- Result: \[result\.md\]\(result\.md\)/u);
    assert.match(readme, new RegExp(`\\.locus/runtime/workflows/${RUN_ID}/`, "u"));
    // Grouped by origin: agent answers first, then continuation inputs naming
    // their source run, then workflow-published documents.
    const agentHeading = readme.indexOf("## Agent documents, in creation order");
    const inputsHeading = readme.indexOf("## Transferred inputs");
    const publishedHeading = readme.indexOf("## Published by the workflow");
    assert.ok(agentHeading > 0 && agentHeading < inputsHeading && inputsHeading < publishedHeading);
    const first = readme.indexOf("01-scout-context.md");
    const second = readme.indexOf("02-planner-round-1-plan.md");
    const third = readme.indexOf("03-critic-round-1-plan-critique.md");
    assert.ok(first > agentHeading && first < second && second < third && third < inputsHeading);
    assert.match(readme, /scout · scout-repository/u);
    assert.match(readme, /\[05-input-plan\.md\]\(05-input-plan\.md\) — transferred from run 20260728-180000-prev/u);
    assert.ok(readme.indexOf("04-workflow-questions.md") > publishedHeading);
  });

  it("renders JSON documents as Markdown, fencing nested shapes and keeping non-JSON verbatim", () => {
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "flat.json", kind: "answer", callId: "call-0001" }),
      record({ artifactId: "call-0002-answer", name: "nested.json", kind: "answer", callId: "call-0002" }),
      record({ artifactId: "call-0003-answer", name: "broken.json", kind: "answer", callId: "call-0003" }),
    ];
    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal: [] },
      evidenceFrom(records, {
        "call-0001-answer": '{"verdict":"accept","defects":[]}',
        "call-0002-answer": '{"rows":[{"id":1}]}',
        "call-0003-answer": "not json at all",
      }),
    );
    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.equal(
      readFileSync(path.join(reportDir, "01-agent-flat.md"), "utf8"),
      "- **verdict**: accept\n- **defects**: (none)\n",
    );
    const fenced = readFileSync(path.join(reportDir, "02-agent-nested.md"), "utf8");
    assert.match(fenced, /^```json\n/u);
    assert.match(fenced, /"rows": \[/u);
    assert.equal(readFileSync(path.join(reportDir, "03-agent-broken.json"), "utf8"), "not json at all");
  });

  it("keeps a structured result out of result.md and says where it lives", () => {
    const root = project();
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "failed",
        result: { ok: false, summary: "round cap" },
        error: "plan was not accepted",
        journal: [],
      },
      evidenceFrom([], {}),
    );
    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.equal(existsSync(path.join(reportDir, "result.md")), false);
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Status: failed/u);
    assert.match(readme, /structured — see `result\.json`/u);
    assert.match(readme, /- Error: plan was not accepted/u);
  });

  it("refuses an unsafe run id and a symlinked report root", () => {
    const root = project();
    const unsafe = writeWorkflowRunReport(
      { projectRoot: root, runId: "../escape", status: "completed", journal: [] },
      evidenceFrom([], {}),
    );
    assert.equal(unsafe.ok, false);

    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(root, ".locus-pi"));
    const symlinked = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal: [] },
      evidenceFrom([], {}),
    );
    assert.equal(symlinked.ok, false);
    assert.equal(readdirSync(elsewhere).length, 0);
  });

  it("survives an unreadable artifact and marks it unavailable in the table of contents", () => {
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "context.md", kind: "answer", callId: "call-0001" }),
      record({ artifactId: "call-0002-answer", name: "plan.md", kind: "answer", callId: "call-0002" }),
    ];
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        journal: [...agentLines("call-0001", "scout", "s"), ...agentLines("call-0002", "planner round 1", "d")],
      },
      evidenceFrom(records, { "call-0002-answer": "plan body" }),
    );
    assert.equal(outcome.ok, true);
    const reportDir = workflowReportDir(root, RUN_ID);
    assert.equal(existsSync(path.join(reportDir, "01-scout-context.md")), false);
    assert.equal(readFileSync(path.join(reportDir, "02-planner-round-1-plan.md"), "utf8"), "plan body");
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /01-scout-context\.md — scout — unavailable/u);
    assert.doesNotMatch(readme, /## Transferred inputs/u);
    assert.doesNotMatch(readme, /## Published by the workflow/u);
  });

  it("is written by the runner next to the machine records on a live run", async () => {
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "report.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  dsl.publishArtifact("task.md", "the operator task");',
        '  return await dsl.agent("answer", { artifact: "review.md", label: "scout" });',
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "report-parent" });
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        return {
          status: "completed",
          agentName: request.agent.name,
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "report",
      createExecutor,
    });

    assert.equal(result.ok, true, result.error);
    const reportDir = workflowReportDir(root, result.runId);
    const names = readdirSync(reportDir).sort();
    assert.deepEqual(names, ["01-scout-review.md", "README.md", "result.md", "task.md"]);
    assert.equal(readFileSync(path.join(reportDir, "01-scout-review.md"), "utf8"), "exact answer");
    assert.equal(readFileSync(path.join(reportDir, "task.md"), "utf8"), "the operator task");
    assert.equal(readFileSync(path.join(reportDir, "result.md"), "utf8"), "exact answer\n");
    const readme = readFileSync(path.join(reportDir, "README.md"), "utf8");
    assert.match(readme, /- Workflow: `report` \(project\)/u);
    assert.match(readme, /01-scout-review\.md/u);
  });
});
