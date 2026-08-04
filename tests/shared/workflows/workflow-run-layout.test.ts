import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  ensureWorkflowRunWorkspaceDir,
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
  workflowRunWorkspaceDir,
} from "../../../extensions/workflows/runtime/workflow-run-layout.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../test-harness.js";

/**
 * T-136 — the run working directory.
 *
 * One question from three sides: can a person find the file an agent wrote,
 * under the name the agent gave it? That needs the directory to exist before the
 * first child starts, its path to reach both the script and the child prompt,
 * and the run's own bookkeeping to stay out of it.
 */

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

/** The directory line of the working-directory note, exactly as the child reads it. */
function runWorkspaceDirFromChildTask(task: string): string {
  const line = task.split("\n")[2];
  assert.ok(line !== undefined && path.isAbsolute(line), `child task must name an absolute directory: ${task}`);
  return line;
}

describe("workflow run working directory", () => {
  it("hands the script and every child one directory, and keeps agent file names verbatim", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "files.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  const answer = await dsl.agent("write the plan", { artifact: "review.md", label: "scout" });',
        "  return `${dsl.runWorkspaceDir()}\\n${answer}`;",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "run-files" });
    // The child learns the directory from its prompt and from nothing else, so a
    // file appearing there proves the prompt carried the path.
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        writeFileSync(path.join(runWorkspaceDirFromChildTask(request.task), "plan.md"), "the plan body", "utf8");
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

    assert.equal(result.ok, true, result.error);
    const workspaceDir = workflowRunWorkspaceDir(workflowRunDir(root, result.runId));
    assert.equal(String(result.result).split("\n")[0], workspaceDir);
    assert.equal(realpathSync(workspaceDir), realpathSync(workflowRunWorkspaceDir(workflowRunDir(root, result.runId))));
    // The exact name the agent chose, and nothing the runtime added beside it.
    assert.deepEqual(readdirSync(workspaceDir), ["plan.md"]);
    assert.equal(readFileSync(path.join(workspaceDir, "plan.md"), "utf8"), "the plan body");

    // Auto-captured material is somewhere else, one document per artifact name;
    // the file the agent wrote is never projected into it.
    const outputNames = readdirSync(workflowRunOutputsDir(workflowRunDir(root, result.runId))).sort();
    assert.deepEqual(outputNames, ["README.md", "workflow-result.md"]);
    assert.ok(!outputNames.includes("plan.md"));
    assert.deepEqual(readdirSync(realpathSync(result.runDir)).sort(), ["outputs", "runtime", "workspace"]);
    assert.ok(readdirSync(workflowRunRuntimeDir(workflowRunDir(root, result.runId))).includes("journal.ndjson"));
  });

  it("creates the working directory before the script runs, even when nothing writes to it", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "empty.workflow.mjs"),
      ["export default async function runWorkflow(dsl) {", "  return dsl.runWorkspaceDir();", "}", ""].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "run-files-empty" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
      createExecutor: (): AgentExecutor => ({
        async run() {
          throw new Error("this workflow starts no child");
        },
      }),
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(existsSync(workflowRunWorkspaceDir(workflowRunDir(root, result.runId))), true);
    assert.deepEqual(readdirSync(workflowRunWorkspaceDir(workflowRunDir(root, result.runId))), []);
  });

  it("gives a read-only child the read-only note, narrowed at the call site", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "readonly.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("review the plan", { readOnly: true });',
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "run-files-readonly" });
    const tasks: string[] = [];

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "readonly",
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          tasks.push(request.task);
          return {
            status: "completed",
            agentName: request.agent.name,
            reason: "reviewed",
            text: "reviewed",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    assert.equal(result.ok, true, result.error);
    // Legacy `readOnly` input is ignored: every workflow child remains writable.
    assert.equal(tasks.length, 1);
    assert.match(
      tasks[0] ?? "",
      new RegExp(workflowRunWorkspaceDir(workflowRunDir(root, result.runId)).replace(/[/\\]/gu, "."), "u"),
    );
    assert.doesNotMatch(tasks[0] ?? "", /This call is read-only/u);
    assert.match(tasks[0] ?? "", /Create any file/u);
  });

  it("refuses to create a run directory through a symlink or under an unsafe run id", () => {
    const root = project();
    assert.throws(() => ensureWorkflowRunWorkspaceDir(root, "../escape"), /Invalid workflow run id/u);

    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    const runId = "20260731-010203-abcd";
    mkdirSync(workflowRunDir(root, runId), { recursive: true });
    symlinkSync(elsewhere, path.join(workflowRunDir(root, runId), "workspace"));

    assert.throws(() => ensureWorkflowRunWorkspaceDir(root, runId), /unsafe/u);
    assert.equal(readdirSync(elsewhere).length, 0);
  });

  it("refuses a replaced outputs symlink for both terminal writes and later reads", async () => {
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
      createExecutor: (): AgentExecutor => ({
        async run() {
          throw new Error("this workflow starts no child");
        },
      }),
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
  it("puts the working-directory note first and leaves the workflow prompt last", () => {
    const task = composeWorkflowChildTask("draft the plan", "/tmp/run/workspace");
    assert.match(task, /^## This workflow run's working directory\n\n\/tmp\/run\/workspace\n/u);
    assert.ok(task.endsWith("draft the plan"));
    assert.match(task, /under the exact name it should have/u);
  });

  it("distinguishes a worktree code workspace from shared publication locations", () => {
    const task = composeWorkflowChildTask("implement the change", "/runs/current", {
      pwd: "/worktrees/child",
      projectRoot: "/projects/main",
      stableOutputDir: "/projects/main/outputs/result",
    });

    assert.match(task, /pwd \(code workspace\): \/worktrees\/child/u);
    assert.match(task, /project root \(shared project location\): \/projects\/main/u);
    assert.match(task, /stable output root \(shared publication location\): \/projects\/main\/outputs\/result/u);
    assert.match(task, /Use pwd for code work/u);
    assert.match(task, /intentional shared locations for publication/u);
  });

  it("leaves the prompt untouched when no directory is configured", () => {
    assert.equal(composeWorkflowChildTask("draft the plan", undefined), "draft the plan");
    assert.equal(composeWorkflowChildTask("draft the plan", "   "), "draft the plan");
  });
});
