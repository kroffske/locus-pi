import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { composeWorkflowChildTask } from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { readWorkflowArtifactRecord } from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  listWorkflowRunIds,
  readWorkflowRunJournal,
  readWorkflowRunJournalState,
  readWorkflowRunResult,
  readWorkflowRunResultText,
  readWorkflowRunSummary,
  workflowRunDir,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import {
  assertWorkflowRunId,
  ensureWorkflowRunDir,
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
  workflowRunFileExists,
  workflowRunsRootDir,
  workflowLegacyRunMigrationMessage,
} from "../../../extensions/workflows/runtime/workflow-run-layout.js";
import { readWorkflowReplayLog } from "../../../extensions/workflows/runtime/workflow-replay.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-run-layout-"));
  roots.push(root);
  mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".agents", "agents", "default.md"),
    "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
  );
  mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
  return root;
}

function workflowWorkspaceFromChildTask(task: string): string {
  const line = task
    .split("\n")
    .find((candidate) =>
      candidate.startsWith("workflow workspace (write intermediate and final workflow files here): "),
    );
  const directory = line?.split(": ").slice(1).join(": ");
  assert.ok(
    directory !== undefined && path.isAbsolute(directory),
    `child task must name an absolute workspace: ${task}`,
  );
  return directory;
}

describe("workflow workspace and run evidence", () => {
  it("uses a unique .locus-pi/plans workspace, gives every child that path once, and keeps run evidence separate", async () => {
    const root = project();
    const workingDirectory = path.join(root, "packages", "docs site");
    mkdirSync(workingDirectory, { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "files.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  const answer = await dsl.agent("write the plan", { label: "writer" });',
        "  return `${dsl.outputDir()}\\n${answer}`;",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "run-files" });
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory };
    const tasks: string[] = [];
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        tasks.push(request.task);
        writeFileSync(path.join(workflowWorkspaceFromChildTask(request.task), "plan.md"), "the plan body", "utf8");
        return {
          status: "completed",
          agentName: request.agent.name,
          reason: "wrote plan.md",
          text: "wrote plan.md",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "files",
      createExecutor,
    });

    const workspaceDir = path.join(root, ".locus-pi", "plans", `${result.runId}-files`);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDir, workspaceDir);
    assert.equal(result.workspaceDirRelative, `.locus-pi/plans/${result.runId}-files`);
    assert.equal(String(result.result).split("\n")[0], `.locus-pi/plans/${result.runId}-files`);
    const persisted = readWorkflowRunResult(root, result.runId);
    assert.equal(persisted?.workspacePhysicalIdentity, `.locus-pi/plans/${result.runId}-files`);
    assert.equal(persisted?.workspacePhysicalIdentityInvalid, undefined);
    assert.deepEqual(readdirSync(workspaceDir), ["plan.md"]);
    assert.equal(readFileSync(path.join(workspaceDir, "plan.md"), "utf8"), "the plan body");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.split(workspaceDir).length - 1, 1);

    const outputNames = readdirSync(workflowRunOutputsDir(workflowRunDir(root, result.runId))).sort();
    assert.deepEqual(outputNames, ["README.md", "workflow-result.md"]);
    assert.ok(!outputNames.includes("plan.md"));
    assert.deepEqual(readdirSync(result.runDir).sort(), ["outputs", "runtime"]);
    assert.ok(readdirSync(workflowRunRuntimeDir(result.runDir)).includes("journal.ndjson"));
    assert.match(result.runDir, /\.locus-pi\/runs\//u);
  });

  it("keeps generated workspaces under .locus-pi/plans from a deep working directory", async () => {
    const root = project();
    const workingDirectory = path.join(root, "p".repeat(150), "q".repeat(150), "r".repeat(150));
    mkdirSync(workingDirectory, { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "long-default.workflow.mjs"),
      "export default function runWorkflow(dsl) { return dsl.outputDir(); }\n",
    );
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory };

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "long-default",
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDirRelative, `.locus-pi/plans/${result.runId}-long-default`);
    const persisted = readWorkflowRunResult(root, result.runId);
    assert.equal(persisted?.workspacePhysicalIdentity, result.workspacePhysicalIdentity);
    assert.equal(persisted?.workspacePhysicalIdentityInvalid, undefined);
  });

  it("creates the default workflow workspace before the script runs", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "empty.workflow.mjs"),
      "export default function runWorkflow(dsl) { return dsl.outputDir(); }\n",
    );
    const harness = createHarness(root, { sessionId: "run-files-empty" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDir, path.join(root, ".locus-pi", "plans", `${result.runId}-empty`));
    assert.equal(existsSync(result.workspaceDir!), true);
    assert.deepEqual(readdirSync(result.workspaceDir!), []);
  });

  it("fails runWorkspaceDir() with the named migration error", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "legacy-workspace.workflow.mjs"),
      "export default function runWorkflow(dsl) { return dsl.runWorkspaceDir(); }\n",
    );
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "legacy-workspace",
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /runWorkspaceDir\(\) was removed/u);
    assert.match(result.error ?? "", /use outputDir\(\)/u);
  });

  it("rejects a Pi working directory outside the project before an agent starts", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-outside-pwd-"));
    roots.push(outside);
    writeFileSync(path.join(root, ".pi", "workflows", "outside.workflow.mjs"), 'export default () => "ok";\n');
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory: outside };

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "outside",
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /working directory must be inside the project root/u);
  });

  it("rejects a physically escaping symlinked Pi working directory", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-symlink-pwd-"));
    roots.push(outside);
    const linked = path.join(root, "linked");
    symlinkSync(outside, linked, "dir");
    writeFileSync(path.join(root, ".pi", "workflows", "linked.workflow.mjs"), 'export default () => "ok";\n');
    const harness = createHarness(root);
    harness.ctx.session = { ...harness.ctx.session!, workingDirectory: linked };

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "linked",
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /physical target escapes the project root/u);
    assert.deepEqual(readdirSync(outside), []);
  });

  it("creates only outputs and runtime for a safe run id", () => {
    const root = project();
    const runId = "20260731-010203-abcd";
    const runDir = ensureWorkflowRunDir(root, runId);
    assert.deepEqual(readdirSync(runDir).sort(), ["outputs", "runtime"]);
    assert.throws(() => ensureWorkflowRunDir(root, "../escape"), /Invalid workflow run id/u);
  });

  it("accepts only bounded safe run-id components and keeps their paths under the run root", () => {
    const root = project();
    const valid = "20260731-010203-abcd";
    assert.equal(assertWorkflowRunId(valid), valid);
    assert.equal(path.relative(workflowRunsRootDir(root), workflowRunDir(root, valid)), valid);

    for (const invalid of [
      "../escape",
      "nested/run",
      "nested\\run",
      "/absolute-looking",
      "C:\\absolute-looking",
      "a".repeat(129),
    ]) {
      assert.throws(() => assertWorkflowRunId(invalid), /Invalid workflow run id/u);
      assert.throws(() => workflowRunDir(root, invalid), /Invalid workflow run id/u);
    }
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const invalid of [true, 1, 1n, null, [valid], { runId: valid }, circular]) {
      assert.throws(() => assertWorkflowRunId(invalid), /Invalid workflow run id/u);
    }
  });

  it("does not classify retired evidence through a symlinked ancestor", () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-legacy-outside-"));
    roots.push(outside);
    rmSync(path.join(root, ".pi"), { recursive: true, force: true });
    mkdirSync(path.join(outside, "locus-pi", "workflows", "legacy-run"), { recursive: true });
    symlinkSync(outside, path.join(root, ".pi"), "dir");

    assert.equal(workflowLegacyRunMigrationMessage(root, "legacy-run"), undefined);
  });

  it("keeps valid run discovery when a malformed directory is present", () => {
    const root = project();
    const validRunId = "20260731-010203-abcd";
    const validRunDir = ensureWorkflowRunDir(root, validRunId);
    writeFileSync(path.join(workflowRunRuntimeDir(validRunDir), "journal.ndjson"), "\n", "utf8");
    mkdirSync(path.join(workflowRunsRootDir(root), "a".repeat(129)));

    assert.deepEqual(listWorkflowRunIds(root), [validRunId]);
  });

  it("treats a missing intermediate runtime directory as absent evidence but rejects an unsafe replacement", () => {
    const root = project();
    const runId = "20260731-010203-runt";
    const runDir = ensureWorkflowRunDir(root, runId);
    const runtimeDir = workflowRunRuntimeDir(runDir);
    const resultPath = path.join(runtimeDir, "result.json");

    rmSync(runtimeDir, { recursive: true, force: true });
    assert.equal(workflowRunFileExists(runDir, resultPath), false);
    assert.equal(readWorkflowRunSummary(root, runId).status, "unknown");

    const outside = mkdtempSync(path.join(tmpdir(), "workflow-run-runtime-outside-"));
    roots.push(outside);
    symlinkSync(outside, runtimeDir, "dir");
    assert.throws(() => workflowRunFileExists(runDir, resultPath), /unsafe|canonical|escapes/u);
    assert.throws(() => readWorkflowRunSummary(root, runId), /unsafe|canonical|escapes/u);
  });

  it("rejects non-canonical resume ids in persisted journal lines", () => {
    const root = project();
    const runId = "20260731-010203-abcd";
    const runDir = ensureWorkflowRunDir(root, runId);
    const journalPath = path.join(workflowRunRuntimeDir(runDir), "journal.ndjson");
    const validSourceSummary = {
      runId,
      status: "completed",
      phase: null,
      agentsStarted: 0,
      agentsEnded: 0,
      agentsReplayed: 0,
      usage: null,
      errors: 0,
      lastKind: null,
      lastTs: null,
      hasResult: false,
    };
    const invalidIds: unknown[] = [true, 1, null, " source-run", "source-run ", "a/b", "../source", "a".repeat(129)];

    for (const invalidId of invalidIds) {
      const resumeLine = {
        ts: "2026-07-31T01:02:03.000Z",
        runId,
        kind: "log",
        source: "runtime",
        message: "[workflow:resume]",
        resumeFromRunId: invalidId,
      };
      writeFileSync(journalPath, `${JSON.stringify(resumeLine)}\n`, "utf8");
      const resumeRead = readWorkflowRunJournalState(root, runId);
      assert.deepEqual(resumeRead.lines, []);
      assert.equal(resumeRead.diagnostics.length, 1);
      assert.match(resumeRead.diagnostics[0]!.message, /resumeFromRunId/u);

      const summaryLine = {
        ...resumeLine,
        resumeFromRunId: runId,
        resumeSourceRunSummary: { ...validSourceSummary, runId: invalidId },
      };
      writeFileSync(journalPath, `${JSON.stringify(summaryLine)}\n`, "utf8");
      const summaryRead = readWorkflowRunJournalState(root, runId);
      assert.deepEqual(summaryRead.lines, []);
      assert.equal(summaryRead.diagnostics.length, 1);
      assert.match(summaryRead.diagnostics[0]!.message, /resumeSourceRunSummary/u);
    }

    const canonicalLine = {
      ts: "2026-07-31T01:02:03.000Z",
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:resume]",
      resumeFromRunId: runId,
      resumeSourceRunSummary: validSourceSummary,
    };
    writeFileSync(journalPath, `${JSON.stringify(canonicalLine)}\n`, "utf8");
    const canonicalRead = readWorkflowRunJournalState(root, runId);
    assert.deepEqual(canonicalRead.diagnostics, []);
    assert.equal(canonicalRead.lines.length, 1);
  });

  it("rejects empty or padded direct-runtime resume ids instead of normalizing them", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "resume-exact.workflow.mjs"),
      'export default function runWorkflow() { return "workflow-ran"; }\n',
    );
    const harness = createHarness(root, { sessionId: "exact-resume-id" });

    for (const resumeFromRunId of ["", " ", " known-run", "known-run "]) {
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "resume-exact",
        resumeFromRunId,
      });

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /Invalid workflow run id/u);
      assert.equal(result.result, undefined);
      assert.equal(result.childRuns, undefined);
      const persisted = readWorkflowRunResult(root, result.runId);
      assert.equal(persisted?.ok, false);
      assert.deepEqual(persisted?.disposition, { status: "failed" });
      assert.equal(persisted?.error, result.error);
    }
  });

  it("terminalizes non-string direct-runtime resume ids without starting child work", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "resume-type.workflow.mjs"),
      'export default async (dsl) => dsl.agent("must not run");\n',
    );
    const harness = createHarness(root, { sessionId: "resume-type" });
    let calls = 0;

    for (const invalid of [true, 1, null, ["known-run"], { runId: "known-run" }]) {
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "resume-type",
        resumeFromRunId: invalid as unknown as string,
        createExecutor: () => ({
          async run() {
            calls += 1;
            throw new Error("child must not start");
          },
        }),
      });

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /Invalid workflow run id/u);
      assert.equal(result.result, undefined);
      const persisted = readWorkflowRunResult(root, result.runId);
      assert.equal(persisted?.ok, false);
      assert.deepEqual(persisted?.disposition, { status: "failed" });
      assert.equal(persisted?.error, result.error);
    }
    assert.equal(calls, 0);
  });

  it("rejects an unsafe resume id before outside result, journal, or replay evidence can be read", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "resume-guard.workflow.mjs"),
      'export default function runWorkflow() { return "workflow-ran"; }\n',
    );
    const unsafeRunId = "../../outside";
    const outsideRuntime = path.join(root, ".pi", "outside", "runtime");
    mkdirSync(outsideRuntime, { recursive: true });
    const outsideEvidence = new Map([
      ["result.json", '{"ok":true,"result":"outside-result"}\n'],
      [
        "journal.ndjson",
        `${JSON.stringify({
          ts: "2026-07-31T01:02:03.000Z",
          runId: unsafeRunId,
          kind: "phase",
          phase: "done",
        })}\n`,
      ],
      ["replay.ndjson", '{"v":2,"seq":0,"kind":"agent","key":"outside","ok":true,"text":"outside-replay"}\n'],
    ]);
    for (const [name, contents] of outsideEvidence) {
      writeFileSync(path.join(outsideRuntime, name), contents, "utf8");
    }

    assert.equal(readWorkflowRunResult(root, unsafeRunId), null);
    assert.deepEqual(readWorkflowRunJournal(root, unsafeRunId), []);
    assert.deepEqual(readWorkflowReplayLog(root, unsafeRunId), []);
    assert.equal(workflowLegacyRunMigrationMessage(root, unsafeRunId), undefined);
    assert.throws(() => readWorkflowRunSummary(root, unsafeRunId), /Invalid workflow run id/u);

    const harness = createHarness(root, { sessionId: "unsafe-resume-id" });
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-guard",
      resumeFromRunId: unsafeRunId,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Invalid workflow run id/u);
    assert.equal(result.result, undefined);
    assert.equal(readWorkflowRunResult(root, result.runId)?.error, result.error);
    for (const [name, contents] of outsideEvidence) {
      assert.equal(readFileSync(path.join(outsideRuntime, name), "utf8"), contents);
    }
  });

  it("refuses a replaced outputs symlink for terminal writes and later reads", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "symlink-output.workflow.mjs"),
      'export default async function runWorkflow() { return "trusted result"; }\n',
    );
    const harness = createHarness(root, { sessionId: "run-output-symlink" });
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "symlink-output",
      onRunStart: ({ runDir }) => {
        rmSync(workflowRunOutputsDir(runDir), { recursive: true });
        symlinkSync(elsewhere, workflowRunOutputsDir(runDir));
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /terminal output was not persisted/u);
    assert.deepEqual(readdirSync(elsewhere), []);
    const readable = readWorkflowRunResultText(root, result.runId);
    assert.equal(readable.status, "ready");
    if (readable.status === "ready") assert.equal(readable.text, "trusted result");
    assert.deepEqual(readdirSync(elsewhere), []);
  });

  it.each([".locus-pi", ".locus-pi/runs"])(
    "rejects a symlinked %s ancestor for discovery and retained evidence reads",
    (ancestor) => {
      const root = project();
      const outside = mkdtempSync(path.join(tmpdir(), "workflow-run-outside-"));
      roots.push(outside);
      const runId = "20260731-010203-feed";
      const lexicalAncestor = path.join(root, ...ancestor.split("/"));
      rmSync(lexicalAncestor, { recursive: true, force: true });
      mkdirSync(path.dirname(lexicalAncestor), { recursive: true });

      const outsideTarget = path.join(outside, path.basename(lexicalAncestor));
      const suffix = ancestor === ".locus-pi" ? ["runs"] : [];
      const outsideRunDir = path.join(outsideTarget, ...suffix, runId);
      const outsideRuntime = path.join(outsideRunDir, "runtime");
      const outsideArtifacts = path.join(outsideRuntime, "artifacts");
      mkdirSync(outsideArtifacts, { recursive: true });
      const artifactBytes = Buffer.from("outside artifact", "utf8");
      const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
      writeFileSync(
        path.join(outsideArtifacts, "index.json"),
        JSON.stringify({
          version: 1,
          runId,
          artifacts: [
            {
              runId,
              artifactId: "outside",
              name: "outside.md",
              sha256: artifactSha256,
              kind: "published",
              mediaType: "text/markdown",
              size: artifactBytes.byteLength,
              relativePath: "outside.md",
              provenance: "published",
              createdAt: "2026-07-31T01:02:03.000Z",
            },
          ],
        }),
      );
      writeFileSync(path.join(outsideArtifacts, "outside.md"), artifactBytes);
      writeFileSync(
        path.join(outsideRuntime, "journal.ndjson"),
        `${JSON.stringify({ ts: "2026-07-31T01:02:03.000Z", runId, kind: "phase", phase: "outside" })}\n`,
      );
      writeFileSync(path.join(outsideRuntime, "replay.ndjson"), '{"v":2,"seq":0,"kind":"agent"}\n');
      writeFileSync(path.join(outsideRuntime, "result.json"), '{"ok":true,"result":"outside"}\n');
      symlinkSync(outsideTarget, lexicalAncestor, "dir");

      assert.deepEqual(listWorkflowRunIds(root), []);
      assert.equal(readWorkflowRunResult(root, runId), null);
      assert.deepEqual(readWorkflowRunJournal(root, runId), []);
      assert.deepEqual(readWorkflowReplayLog(root, runId), []);
      assert.equal(readWorkflowArtifactRecord(root, runId, "outside").status, "invalid");
    },
  );

  it("refuses terminal writes after the canonical runs root is replaced by a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-terminal-outside-"));
    roots.push(outside);
    writeFileSync(
      path.join(root, ".pi", "workflows", "replace-runs.workflow.mjs"),
      'export default () => "must not escape";\n',
    );
    const harness = createHarness(root, { sessionId: "replace-runs" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "replace-runs",
      onRunStart: () => {
        rmSync(workflowRunsRootDir(root), { recursive: true });
        symlinkSync(outside, workflowRunsRootDir(root), "dir");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /canonical physical|unsafe|symlink/u);
    assert.deepEqual(readdirSync(outside), []);
  });
});

describe("workflow child task composition", () => {
  it("names the workflow workspace exactly once and leaves the workflow prompt last", () => {
    const task = composeWorkflowChildTask("draft the plan", "/project/tmp/plan");
    assert.match(task, /^## Workflow filesystem locations/u);
    assert.equal(task.split("/project/tmp/plan").length - 1, 1);
    assert.ok(task.endsWith("draft the plan"));
    assert.match(task, /replace assigned files idempotently/u);
  });

  it("distinguishes a worktree code workspace from the workflow workspace and project context", () => {
    const task = composeWorkflowChildTask("implement the change", "/projects/main/tmp/review", {
      pwd: "/worktrees/child",
      projectRoot: "/projects/main",
    });

    assert.match(task, /workflow workspace .*: \/projects\/main\/tmp\/review/u);
    assert.match(task, /pwd \(code workspace\): \/worktrees\/child/u);
    assert.match(task, /project root \(source context\): \/projects\/main/u);
    assert.match(task, /Use pwd for code work/u);
    assert.match(task, /not as a default artifact destination/u);
  });

  it("leaves the prompt untouched when no directory or location is configured", () => {
    assert.equal(composeWorkflowChildTask("draft the plan", undefined), "draft the plan");
    assert.equal(composeWorkflowChildTask("draft the plan", "   "), "draft the plan");
  });
});
