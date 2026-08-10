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
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { composeWorkflowChildTask } from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { readWorkflowRunResultText, workflowRunDir } from "../../../extensions/workflows/runtime/workflow-journal.js";
import {
  ensureWorkflowRunDir,
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
} from "../../../extensions/workflows/runtime/workflow-run-layout.js";
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
  it("uses <pwd>/tmp/<workflow-name>, gives every child that path once, and keeps run evidence separate", async () => {
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

    const workspaceDir = path.join(workingDirectory, "tmp", "files");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.workspaceDir, workspaceDir);
    assert.equal(result.workspaceDirRelative, "packages/docs site/tmp/files");
    assert.equal(String(result.result).split("\n")[0], "packages/docs site/tmp/files");
    assert.deepEqual(readdirSync(workspaceDir), ["plan.md"]);
    assert.equal(readFileSync(path.join(workspaceDir, "plan.md"), "utf8"), "the plan body");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.split(workspaceDir).length - 1, 1);

    const outputNames = readdirSync(workflowRunOutputsDir(workflowRunDir(root, result.runId))).sort();
    assert.deepEqual(outputNames, ["README.md", "workflow-result.md"]);
    assert.ok(!outputNames.includes("plan.md"));
    assert.deepEqual(readdirSync(result.runDir).sort(), ["outputs", "runtime"]);
    assert.ok(readdirSync(workflowRunRuntimeDir(result.runDir)).includes("journal.ndjson"));
    assert.match(result.runDir, /\.pi\/locus-pi\/runs\//u);
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
    assert.equal(result.workspaceDir, path.join(root, "tmp", "empty"));
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
