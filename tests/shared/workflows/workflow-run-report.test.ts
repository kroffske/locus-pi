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
import { readWorkflowRunJournalState } from "../../../extensions/_shared/workflow-journal.js";
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

  it("names the model each agent document ran on, and only from agent_end", () => {
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "cheap.md", kind: "answer", callId: "call-0001", stage: "draft" }),
      record({
        artifactId: "call-0002-answer",
        name: "strong.md",
        kind: "answer",
        callId: "call-0002",
        stage: "judge",
      }),
      record({ artifactId: "call-0003-answer", name: "old.md", kind: "answer", callId: "call-0003", stage: "legacy" }),
    ];
    const journal = [
      ...agentLines("call-0001", "cheap stage", "draft"),
      ...agentLines("call-0002", "strong stage", "judge"),
      ...agentLines("call-0003", "legacy stage", "legacy"),
    ];
    // agent_start carries a REQUEST; the report must ignore it. If it did not, the
    // legacy call below would be reported as having run on `test/strong`, which
    // nothing observed.
    const startFor = (callId: string) => journal.find((l) => l.callId === callId && l.kind === "agent_start")!;
    const endFor = (callId: string) => journal.find((l) => l.callId === callId && l.kind === "agent_end")!;
    startFor("call-0001").requestedModel = "test/fast";
    endFor("call-0001").executedModel = "test/fast";
    startFor("call-0002").requestedModel = "test/strong";
    endFor("call-0002").executedModel = "test/strong";
    startFor("call-0003").requestedModel = "test/strong";
    endFor("call-0003").modelRoleFallback = 'modelRole "smol" is not assigned in any model-roles layer';

    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal },
      evidenceFrom(records, {
        "call-0001-answer": "cheap body",
        "call-0002-answer": "strong body",
        "call-0003-answer": "legacy body",
      }),
    );

    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.match(readme, /cheap stage · draft · ran on test\/fast/u);
    assert.match(readme, /strong stage · judge · ran on test\/strong/u);
    // No executedModel on that line ⇒ the report says nothing about a model, and
    // says the tier degraded. Absence is never filled in from the request.
    assert.match(readme, /legacy stage · legacy · declared tier unassigned/u);
    assert.equal(/legacy stage · legacy · ran on/u.test(readme), false);
  });

  it("spells out an unavailable readback instead of naming a model called `unavailable`", () => {
    // `unavailable` is the D6 sentinel for "the peer reported nothing". Rendered as
    // "ran on unavailable" it reads to a human as a model NAMED unavailable — a
    // fabricated model name in the reader's own copy of the evidence.
    const root = project();
    const records = [
      record({ artifactId: "call-0001-answer", name: "quiet.md", kind: "answer", callId: "call-0001", stage: "draft" }),
    ];
    const journal = [...agentLines("call-0001", "quiet stage", "draft")];
    journal.find((l) => l.callId === "call-0001" && l.kind === "agent_end")!.executedModel = "unavailable";

    const outcome = writeWorkflowRunReport(
      { projectRoot: root, runId: RUN_ID, status: "completed", journal },
      evidenceFrom(records, { "call-0001-answer": "quiet body" }),
    );

    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.match(readme, /quiet stage · draft · executed model unavailable/u);
    assert.equal(/ran on unavailable/u.test(readme), false);
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

  it("names every discarded transport attempt, its callId and its class", async () => {
    // A retried stage looks like one clean answer in the documents list. The second child
    // really ran, burned an invocation and left its own transcript, so the reader's copy has
    // to say so — otherwise the only trace of the second bill is a machine file.
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "retried.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("answer", {',
        '    artifact: "review.md",',
        '    label: "scout",',
        '    phase: "review",',
        "    readOnly: true,",
        "    attempts: 2,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "report-retry-parent" });
    let child = 0;
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        child += 1;
        // First child: the host turn budget expired mid-answer. Second: a real answer.
        if (child === 1) {
          return {
            status: "failed",
            agentName: request.agent.name,
            reason: "Child agent turn exceeded the 5000ms budget and was aborted.",
            failureCause: "host-turn-timeout",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        }
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
      name: "retried",
      createExecutor,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(child, 2, "the transport failure must have cost a second real child");

    const readme = readFileSync(path.join(workflowReportDir(root, result.runId), "README.md"), "utf8");
    assert.match(readme, /## Retried agent calls/u);
    // BOTH attempts, each by its own callId, and the discarded one by its class.
    assert.match(readme, /- attempt 1 of 2 — `call-0001` — failed \(host-turn-timeout\)/u);
    assert.match(readme, /- attempt 2 of 2 — `call-0002` — completed/u);
    assert.match(readme, /- scout · review/u);

    // The same two attempts are readable in the journal the report was projected from,
    // and the journal a reader loads back reports no structural problem.
    const journal = readWorkflowRunJournalState(root, result.runId);
    assert.deepEqual(journal.diagnostics, []);
    const ends = journal.lines.filter((line) => line.kind === "agent_end");
    assert.deepEqual(
      ends.map((line) => [line.callId, line.attempt, line.attempts, line.status, line.failureCause]),
      [
        ["call-0001", 1, 2, "failed", "host-turn-timeout"],
        ["call-0002", 2, 2, "completed", undefined],
      ],
    );
    assert.equal(
      journal.lines.filter((line) => line.message?.startsWith("[workflow:retry]") === true).length,
      1,
      "the boundary between the two attempts is named in the journal",
    );
  });

  it("names a retry whose second attempt threw, which leaves only one agent_end behind", async () => {
    // The failure path that hides a retry: attempt 1 times out and IS re-run, attempt 2
    // throws. A thrown attempt never reaches an `agent_end`, so a report built from
    // `agent_end` alone sees one attempt, drops the group, and renders a stage that ran
    // twice and cost twice as if it never retried — while the run's own error message
    // names only the throw. The terminal `error` line is that attempt's record and has to
    // carry the same attempt identity.
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "threw.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("answer", {',
        '    artifact: "review.md",',
        '    label: "scout",',
        '    phase: "review",',
        "    readOnly: true,",
        "    attempts: 2,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "report-threw-parent" });
    let child = 0;
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        child += 1;
        if (child === 1) {
          return {
            status: "failed",
            agentName: request.agent.name,
            reason: "Child agent turn exceeded the 5000ms budget and was aborted.",
            failureCause: "host-turn-timeout",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        }
        throw new Error("the child host vanished mid-turn");
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "threw",
      createExecutor,
    });

    assert.equal(result.ok, false, "a thrown attempt ends the run");
    assert.equal(child, 2, "the transport failure must have cost a second real child");

    const readme = readFileSync(path.join(workflowReportDir(root, result.runId), "README.md"), "utf8");
    assert.match(readme, /## Retried agent calls/u);
    assert.match(readme, /- attempt 1 of 2 — `call-0001` — failed \(host-turn-timeout\)/u);
    // The thrown attempt is named as itself — not "failed", and not silently absent.
    assert.match(readme, /- attempt 2 of 2 — `call-0002` — threw/u);

    // The journal the report was projected from: one agent_end, one error line, the same
    // logical call named on both, and no structural problem when a reader loads it back.
    const journal = readWorkflowRunJournalState(root, result.runId);
    assert.deepEqual(journal.diagnostics, []);
    const ends = journal.lines.filter((line) => line.kind === "agent_end");
    const errors = journal.lines.filter((line) => line.kind === "error" && line.callId !== undefined);
    assert.deepEqual(
      ends.map((line) => [line.callId, line.attempt, line.attempts]),
      [["call-0001", 1, 2]],
    );
    assert.deepEqual(
      errors.map((line) => [line.callId, line.attempt, line.attempts]),
      [["call-0002", 2, 2]],
    );
    assert.equal(errors[0]?.logicalCallId, ends[0]?.logicalCallId);
    assert.notEqual(errors[0]?.logicalCallId, undefined);
  });

  it("says nothing about retries when a call needed only one attempt", () => {
    // The section is evidence, not decoration: a call that declared a budget and did not
    // spend it must not grow a "Retried agent calls" heading.
    const root = project();
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        journal: [
          {
            ts: "2026-07-28T19:00:00.000Z",
            runId: RUN_ID,
            kind: "agent_end",
            agent: "default",
            callId: "call-0001",
            logicalCallId: "logical-0001",
            attempt: 1,
            attempts: 3,
            status: "completed",
          },
        ] as WorkflowJournalLine[],
      },
      evidenceFrom([], {}),
    );

    assert.equal(outcome.ok, true);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    assert.doesNotMatch(readme, /Retried agent calls/u);
  });

  it("keeps two interleaved calls apart when agent, label, phase and group all agree", () => {
    // `parallel()` can run two calls that agree on every descriptive field, and their
    // attempts then interleave in the journal. Grouping by those fields would put three of
    // these four attempts in one group and leave the other looking like it never retried —
    // a section that reads as evidence while attributing one stage's second bill to another.
    // Only the runtime's own logical-call identity separates them.
    const root = project();
    const shared = { runId: RUN_ID, kind: "agent_end" as const, agent: "default", label: "advise", phase: "advise" };
    const outcome = writeWorkflowRunReport(
      {
        projectRoot: root,
        runId: RUN_ID,
        status: "completed",
        journal: [
          // A's first attempt, then B's first attempt, then A's second, then B's second.
          {
            ...shared,
            ts: "2026-07-28T19:00:01.000Z",
            groupId: "group-1",
            callId: "call-0001",
            logicalCallId: "logical-0001",
            attempt: 1,
            attempts: 2,
            status: "failed",
            failureCause: "host-turn-timeout",
          },
          {
            ...shared,
            ts: "2026-07-28T19:00:02.000Z",
            groupId: "group-1",
            callId: "call-0002",
            logicalCallId: "logical-0002",
            attempt: 1,
            attempts: 2,
            status: "failed",
            failureCause: "call-timeout",
          },
          {
            ...shared,
            ts: "2026-07-28T19:00:03.000Z",
            groupId: "group-1",
            callId: "call-0003",
            logicalCallId: "logical-0001",
            attempt: 2,
            attempts: 2,
            status: "completed",
          },
          {
            ...shared,
            ts: "2026-07-28T19:00:04.000Z",
            groupId: "group-1",
            callId: "call-0004",
            logicalCallId: "logical-0002",
            attempt: 2,
            attempts: 2,
            status: "completed",
          },
        ] as WorkflowJournalLine[],
      },
      evidenceFrom([], {}),
    );

    assert.equal(outcome.ok, true);
    const readme = readFileSync(path.join(workflowReportDir(root, RUN_ID), "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Retried agent calls"));
    // Two calls, each with exactly its OWN two attempts. Grouping by the descriptive fields
    // produces one bullet with three attempt lines instead, so this fails on that shape.
    assert.equal(section.split("\n").filter((line) => line === "- advise · advise").length, 2);
    assert.match(
      section,
      /- attempt 1 of 2 — `call-0001` — failed \(host-turn-timeout\)\n {2}- attempt 2 of 2 — `call-0003` — completed/u,
    );
    assert.match(
      section,
      /- attempt 1 of 2 — `call-0002` — failed \(call-timeout\)\n {2}- attempt 2 of 2 — `call-0004` — completed/u,
    );
  });
});
