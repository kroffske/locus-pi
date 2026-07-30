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
import { workflowRunDir } from "../../../extensions/workflows/runtime/workflow-journal.js";
import {
  ensureWorkflowRunFilesDir,
  workflowRunFilesDir,
  workflowRunLogsDir,
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
function runFilesDirFromChildTask(task: string): string {
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
        "  return `${dsl.runFilesDir()}\\n${answer}`;",
        "}",
        "",
      ].join("\n"),
    );
    const harness = createHarness(root, { sessionId: "run-files" });
    // The child learns the directory from its prompt and from nothing else, so a
    // file appearing there proves the prompt carried the path.
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        writeFileSync(path.join(runFilesDirFromChildTask(request.task), "plan.md"), "the plan body", "utf8");
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
    const filesDir = path.join(realpathSync(result.runDir), "files");
    assert.equal(String(result.result).split("\n")[0], filesDir);
    assert.equal(filesDir, realpathSync(workflowRunFilesDir(root, result.runId)));
    // The exact name the agent chose, and nothing the runtime added beside it.
    assert.deepEqual(readdirSync(filesDir), ["plan.md"]);
    assert.equal(readFileSync(path.join(filesDir, "plan.md"), "utf8"), "the plan body");

    // Auto-captured material is somewhere else, one document per artifact name;
    // the file the agent wrote is never projected into it.
    const logNames = readdirSync(workflowRunLogsDir(root, result.runId)).sort();
    assert.deepEqual(logNames, ["README.md", "result.md", "review.md"]);
    assert.ok(!logNames.includes("plan.md"));
  });

  it("creates the working directory before the script runs, even when nothing writes to it", async () => {
    const root = project();
    writeFileSync(
      path.join(root, ".pi", "workflows", "empty.workflow.mjs"),
      ["export default async function runWorkflow(dsl) {", "  return dsl.runFilesDir();", "}", ""].join("\n"),
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
    assert.equal(existsSync(workflowRunFilesDir(root, result.runId)), true);
    assert.deepEqual(readdirSync(workflowRunFilesDir(root, result.runId)), []);
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
    // The catalog agent is writable; `readOnly: true` narrowed it at the call
    // site, and the note follows the EFFECTIVE capability rather than the catalog.
    assert.equal(tasks.length, 1);
    assert.match(tasks[0] ?? "", new RegExp(workflowRunFilesDir(root, result.runId).replace(/[/\\]/gu, "."), "u"));
    assert.match(tasks[0] ?? "", /This call is read-only/u);
    assert.doesNotMatch(tasks[0] ?? "", /Create any file/u);
  });

  it("refuses to create a run directory through a symlink or under an unsafe run id", () => {
    const root = project();
    assert.throws(() => ensureWorkflowRunFilesDir(root, "../escape"), /Invalid workflow run id/u);

    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    const runId = "20260731-010203-abcd";
    mkdirSync(workflowRunDir(root, runId), { recursive: true });
    symlinkSync(elsewhere, path.join(workflowRunDir(root, runId), "files"));

    assert.throws(() => ensureWorkflowRunFilesDir(root, runId), /unsafe/u);
    assert.equal(readdirSync(elsewhere).length, 0);
  });
});

describe("workflow child task composition", () => {
  it("puts the working-directory note first and leaves the workflow prompt last", () => {
    const task = composeWorkflowChildTask("draft the plan", "/tmp/run/files");
    assert.match(task, /^## This workflow run's working directory\n\n\/tmp\/run\/files\n/u);
    assert.ok(task.endsWith("draft the plan"));
    assert.match(task, /under the exact name it should have/u);
  });

  it("names the directory to a read-only child without telling it to create anything", () => {
    const task = composeWorkflowChildTask("review the plan", "/tmp/run/files", { readOnly: true });
    assert.match(task, /^## This workflow run's working directory\n\n\/tmp\/run\/files\n/u);
    assert.ok(task.endsWith("review the plan"));
    assert.match(task, /This call is read-only/u);
    // The instruction a child with no write capability could not carry out.
    assert.doesNotMatch(task, /Create any file/u);
  });

  it("leaves the prompt untouched when no directory is configured", () => {
    assert.equal(composeWorkflowChildTask("draft the plan", undefined), "draft the plan");
    assert.equal(composeWorkflowChildTask("draft the plan", "   "), "draft the plan");
    assert.equal(composeWorkflowChildTask("draft the plan", undefined, { readOnly: true }), "draft the plan");
  });
});
