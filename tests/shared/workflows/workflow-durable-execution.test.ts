import { spawn } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  acquireWorkflowRootLease,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  releaseWorkflowRootLease,
  resolveWorkflowOutputDirectory,
  workflowOutputStateDir,
} from "../../../extensions/workflows/runtime/workflow-output.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../test-harness.js";

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-durable-"));
  mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
  return root;
}

function writeWorkflow(root: string, name: string, source: string): void {
  writeFileSync(path.join(root, ".pi", "workflows", `${name}.workflow.mjs`), source, "utf8");
}

function authoredPrompt(request: AgentRunRequest): string {
  return request.task.slice(request.task.lastIndexOf("\n\n---\n\n") + "\n\n---\n\n".length);
}

function executor(
  run: (prompt: string, request: AgentRunRequest, signal: AbortSignal) => Promise<string> | string,
): () => AgentExecutor {
  return () => ({
    async run(request, signal) {
      try {
        const text = await run(authoredPrompt(request), request, signal);
        return {
          status: "completed" as const,
          agentName: request.agent.name,
          reason: "answered",
          text,
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      } catch (error) {
        return {
          status: "failed" as const,
          agentName: request.agent.name,
          reason: error instanceof Error ? error.message : String(error),
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      }
    },
  });
}

const CHILD = `export const meta = { name: "child", profile: "standard" };
export default async function run(dsl, input) {
  await dsl.agent("write:" + input, { label: "write item" });
  return dsl.publishPrimaryFile(dsl.items()[0] + ".md");
}
`;

const PARENT = `export const meta = { name: "parent", profile: "standard" };
export default async function run(dsl, input) {
  const items = dsl.items();
  const results = [];
  for (const item of items) {
    results.push(await dsl.invokeWorkflow({
      name: "child",
      key: item,
      keys: items,
      input: input + ":" + item,
      items: [item],
      outputDir: dsl.outputDir(),
    }));
  }
  return results;
}
`;

describe("stable workflow output paths", () => {
  it("defaults the stable namespace from the saved workflow name", async () => {
    const root = project();
    writeWorkflow(root, "default-output", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "default-output",
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.workspaceDirRelative).toBe("tmp/default-output");
    expect(result.workspaceDir).toBe(path.join(root, "tmp", "default-output"));
  });

  it("derives distinct safe default namespaces for legacy names beginning with underscore or hyphen", async () => {
    const root = project();
    const harness = createHarness(root);
    const names = ["_legacy", "-legacy", "legacy"];
    for (const name of names) writeWorkflow(root, name, `export default () => ${JSON.stringify(name)};\n`);

    const results = await Promise.all(
      names.map((name) =>
        runWorkflowScript({
          pi: harness.pi,
          ctx: harness.ctx,
          signal: new AbortController().signal,
          name,
        }),
      ),
    );

    for (const result of results) {
      expect(result.ok, result.error).toBe(true);
      expect(result.workspaceDirRelative).toMatch(/^tmp(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u);
    }
    const namespaces = results.map((result) => result.workspaceDirRelative!);
    expect(new Set(namespaces).size).toBe(names.length);
    expect(namespaces[2]).toBe("tmp/legacy");
    expect(namespaces[0]).toMatch(/^tmp\/by-workflow-name\/[a-f0-9]{64}$/u);
    expect(namespaces[1]).toMatch(/^tmp\/by-workflow-name\/[a-f0-9]{64}$/u);
  });

  it.each(["/tmp/escape", "../escape", "outputs/../escape", " outputs/task", "outputs/task/"])(
    "rejects unsafe outputDir %s before an agent starts",
    async (outputDir) => {
      const root = project();
      writeWorkflow(root, "empty", `export default () => "ok";\n`);
      let calls = 0;
      const harness = createHarness(root);
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "empty",
        outputDir,
        createExecutor: executor(() => {
          calls += 1;
          return "unused";
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/outputDir|path component|project-relative/u);
      expect(calls).toBe(0);
    },
  );

  it("rejects an output path whose existing ancestor is a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-output-outside-"));
    mkdirSync(path.join(root, "outputs"));
    symlinkSync(outside, path.join(root, "outputs", "linked"), "dir");
    writeWorkflow(root, "empty", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
      outputDir: "outputs/linked/task",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("symlink");
  });

  it("keeps run-local outputDir compatibility and exposes a distinct stable primary-file reference", async () => {
    const root = project();
    writeWorkflow(
      root,
      "writer",
      `export default async function run(dsl) {
  await dsl.agent("write result");
  return dsl.publishPrimaryFile("result.md");
}\n`,
    );
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "task", "result.md");

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "writer",
      outputDir: "outputs/task",
      createExecutor: executor(() => {
        writeFileSync(stableFile, "durable result\n", "utf8");
        return "written";
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.stableOutputDir).toBe(path.join(root, "outputs", "task"));
    expect(result.stableOutputDirRelative).toBe("outputs/task");
    expect(result.primaryFile).toMatchObject({
      relativePath: "result.md",
      absolutePath: stableFile,
      bytes: 15,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(readFileSync(stableFile, "utf8")).toBe("durable result\n");
    expect(path.join(result.runDir, "outputs")).not.toBe(result.stableOutputDir);
    expect(result.primaryOutputPath).not.toBe(stableFile);
  });

  it("keeps stable files available when later workflow work fails", async () => {
    const root = project();
    writeWorkflow(
      root,
      "failing-writer",
      `export default async function run(dsl) {
  await dsl.agent("write then fail");
  throw new Error("later stage failed");
}\n`,
    );
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "failed", "partial.md");

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "failing-writer",
      outputDir: "outputs/failed",
      createExecutor: executor(() => {
        writeFileSync(stableFile, "inspectable partial\n", "utf8");
        return "written";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("later stage failed");
    expect(readFileSync(stableFile, "utf8")).toBe("inspectable partial\n");
  });

  it("rejects missing, empty, and symlinked primary files", async () => {
    const root = project();
    writeWorkflow(root, "primary", `export default (dsl) => dsl.publishPrimaryFile(dsl.items()[0]);\n`);
    const output = path.join(root, "outputs", "primary-checks");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "empty.md"), "", "utf8");
    const outside = path.join(root, "outside.md");
    writeFileSync(outside, "outside\n", "utf8");
    symlinkSync(outside, path.join(output, "linked.md"));
    const harness = createHarness(root);

    for (const [file, error] of [
      ["missing.md", "ENOENT"],
      ["empty.md", "empty"],
      ["linked.md", "symlink"],
    ] as const) {
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "primary",
        items: [file],
        outputDir: "outputs/primary-checks",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(error);
    }
  });
});

describe("saved child execution and item checkpoints", () => {
  it("runs real children with lineage, then skips completed keys despite changed opaque payload", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const calls: string[] = [];
    const createExecutor = executor((prompt) => {
      calls.push(prompt);
      const payload = prompt.slice("write:".length);
      const key = payload.slice(payload.lastIndexOf(":") + 1);
      writeFileSync(path.join(root, "outputs", "resume", `${key}.md`), `${payload}\n`, "utf8");
      return "written";
    });

    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-one",
      items: ["alpha", "beta"],
      outputDir: "outputs/resume",
      createExecutor,
    });

    expect(first.ok, first.error).toBe(true);
    expect(calls).toEqual(["write:payload-one:alpha", "write:payload-one:beta"]);
    expect(first.childRuns).toHaveLength(2);
    expect(first.result).toEqual([
      expect.objectContaining({ status: "completed", key: "alpha", runId: expect.any(String) }),
      expect.objectContaining({ status: "completed", key: "beta", runId: expect.any(String) }),
    ]);
    for (const exposed of first.result as Array<Record<string, unknown>>) {
      expect(exposed).not.toHaveProperty("childScriptSha256");
      expect(exposed).not.toHaveProperty("runDir");
    }
    for (const child of first.childRuns ?? []) {
      expect(child.status).toBe("completed");
      const persisted = JSON.parse(readFileSync(path.join(child.runDir!, "runtime", "result.json"), "utf8"));
      expect(persisted.lineage).toMatchObject({
        rootRunId: first.runId,
        parentRunId: first.runId,
        parentItemKey: child.key,
        depth: 1,
      });
      expect(persisted.workspaceDir).toBe(path.join(root, "outputs", "resume"));
      expect(persisted.workspaceDirRelative).toBe("outputs/resume");
      expect(persisted.stableOutputDirRelative).toBe("outputs/resume");
    }
    expect(first.journal.filter((line) => line.message?.includes("[workflow:child-start]"))).toHaveLength(2);
    expect(first.journal.filter((line) => line.message?.includes("[workflow:child-end]"))).toHaveLength(2);

    calls.length = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-two",
      items: ["alpha", "beta"],
      outputDir: "outputs/resume",
      createExecutor,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual([]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha", sourceRunId: first.childRuns?.[0]?.runId }),
      expect.objectContaining({ status: "skipped", key: "beta", sourceRunId: first.childRuns?.[1]?.runId }),
    ]);
    expect(resumed.result).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha", sourceRunId: first.childRuns?.[0]?.runId }),
      expect.objectContaining({ status: "skipped", key: "beta", sourceRunId: first.childRuns?.[1]?.runId }),
    ]);
    expect(resumed.journal.filter((line) => line.message?.includes("[workflow:child-skip]"))).toHaveLength(2);
    expect(resumed.journal.some((line) => line.message?.includes(`sourceRunId=${first.childRuns?.[0]?.runId}`))).toBe(
      true,
    );
    expect(readFileSync(path.join(root, "outputs", "resume", "alpha.md"), "utf8")).toBe("payload-one:alpha\n");
    expect(resumed.journal.some((event) => event.message?.includes("[workflow:project-source] policy=live"))).toBe(
      true,
    );
  });

  it("retries only an incomplete key and invalidates checkpoints when child source changes", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const calls: string[] = [];
    let failBeta = true;
    const createExecutor = executor((prompt) => {
      calls.push(prompt);
      const key = prompt.slice(prompt.lastIndexOf(":") + 1);
      if (key === "beta" && failBeta) throw new Error("interrupted beta");
      writeFileSync(path.join(root, "outputs", "retry", `${key}.md`), `${prompt}\n`, "utf8");
      return "written";
    });
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha", "beta"],
        outputDir: "outputs/retry",
        createExecutor,
      });

    const interrupted = await run();
    expect(interrupted.ok).toBe(false);
    expect(calls).toEqual(["write:payload:alpha", "write:payload:beta"]);

    calls.length = 0;
    failBeta = false;
    const resumed = await run();
    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual(["write:payload:beta"]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha" }),
      expect.objectContaining({ status: "completed", key: "beta" }),
    ]);

    calls.length = 0;
    writeWorkflow(root, "child", `${CHILD}\n// changed source identity\n`);
    const changed = await run();
    expect(changed.ok, changed.error).toBe(true);
    expect(calls).toEqual(["write:payload:alpha", "write:payload:beta"]);
  });

  it("reruns completed children when checkpointed primary evidence is missing or changed", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "stale-primary", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/stale-primary",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, `version ${calls}\n`, "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    unlinkSync(stableFile);
    const missing = await run();
    expect(missing.ok, missing.error).toBe(true);
    expect(missing.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(missing.journal.some((line) => line.message?.includes("[workflow:checkpoint-stale]"))).toBe(true);

    writeFileSync(stableFile, "tampered\n", "utf8");
    const changed = await run();
    expect(changed.ok, changed.error).toBe(true);
    expect(changed.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(changed.journal.some((line) => line.message?.includes("changed since checkpoint"))).toBe(true);
    expect(calls).toBe(3);
    expect(readFileSync(stableFile, "utf8")).toBe("version 3\n");
  });

  it("quarantines a corrupt checkpoint and reruns the child", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "corrupt-checkpoint", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/corrupt-checkpoint",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, `version ${calls}\n`, "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/corrupt-checkpoint", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointFile = path.join(
      checkpoints,
      readdirSync(checkpoints).find((name) => name.endsWith(".json"))!,
    );
    writeFileSync(checkpointFile, "not json\n", "utf8");

    const rerun = await run();
    expect(rerun.ok, rerun.error).toBe(true);
    expect(rerun.childRuns).toEqual([expect.objectContaining({ status: "completed", key: "alpha" })]);
    expect(calls).toBe(2);
    expect(readdirSync(checkpoints).some((name) => name.includes(".json.stale-"))).toBe(true);
  });

  it("fails closed without quarantining checkpoint paths that cannot be read as regular files", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "checkpoint-io-error", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/checkpoint-io-error",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, "complete\n", "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/checkpoint-io-error", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    unlinkSync(checkpointFile);
    mkdirSync(checkpointFile);

    const failed = await run();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("not a regular file");
    expect(calls).toBe(1);
    expect(existsSync(checkpointFile)).toBe(true);
    expect(readdirSync(checkpoints).some((name) => name.includes(".stale-"))).toBe(false);
  });

  it("fails closed without quarantining a checkpoint on a transient permission error", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "checkpoint-permission", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/checkpoint-permission",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, "complete\n", "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/checkpoint-permission", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    chmodSync(checkpointFile, 0o000);
    try {
      const failed = await run();
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatch(/EACCES|permission denied/u);
      expect(calls).toBe(1);
      expect(readdirSync(checkpoints).some((name) => name.includes(".stale-"))).toBe(false);
    } finally {
      chmodSync(checkpointFile, 0o600);
    }
  });

  it.each([
    ["duplicate", ["same", "same"]],
    ["unsafe", ["safe", "not safe"]],
  ])("rejects %s item keys before any child or agent starts", async (_label, items) => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    let calls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload",
      items,
      outputDir: `outputs/${_label}`,
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicated|child key/u);
    expect(calls).toBe(0);
    expect(result.childRuns).toBeUndefined();
  });

  it("shares the physical invocation fuse instead of resetting it in each child", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    let calls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload",
      items: ["alpha", "beta"],
      outputDir: "outputs/shared-budget",
      budget: { totalAgents: 1 },
      createExecutor: executor((prompt) => {
        calls += 1;
        const key = prompt.slice(prompt.lastIndexOf(":") + 1);
        writeFileSync(path.join(root, "outputs", "shared-budget", `${key}.md`), "done\n", "utf8");
        return "written";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("maxTotalAgentInvocations cap of 1");
    expect(calls).toBe(1);
  });

  it("shares one concurrency gate across parallel saved children", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(
      root,
      "parallel-parent",
      `export default async function run(dsl) {
  const items = dsl.items();
  return dsl.parallel(items.map((item) => () => dsl.invokeWorkflow({
    name: "child", key: item, keys: items, input: item, items: [item], outputDir: dsl.outputDir(),
  })));
}\n`,
    );
    const harness = createHarness(root);
    let active = 0;
    let peak = 0;

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parallel-parent",
      items: ["alpha", "beta"],
      outputDir: "outputs/shared-concurrency",
      budget: { concurrency: 1 },
      createExecutor: executor(async (prompt) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        const key = prompt.slice("write:".length);
        writeFileSync(path.join(root, "outputs", "shared-concurrency", `${key}.md`), "done\n", "utf8");
        active -= 1;
        return "written";
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(peak).toBe(1);
  });

  it("propagates root cancellation into an active saved child", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const pending = runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: controller.signal,
      name: "parent",
      input: "payload",
      items: ["alpha"],
      outputDir: "outputs/cancelled",
      createExecutor: () => ({
        async run(request, signal) {
          childSignal = signal;
          notifyStarted?.();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return {
            status: "cancelled" as const,
            agentName: request.agent.name,
            reason: "root cancelled",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    await started;
    controller.abort(new Error("operator stop"));
    const result = await pending;

    expect(childSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.disposition?.status).toBe("cancelled");
    expect(result.childRuns).toEqual([expect.objectContaining({ status: "cancelled", key: "alpha" })]);
    const childRunId = result.childRuns?.[0]?.runId;
    expect(childRunId).toBeTypeOf("string");
    expect(
      result.journal.some(
        (line) => line.message?.includes(`[workflow:child-start]`) && line.message.includes(childRunId!),
      ),
    ).toBe(true);
    expect(
      result.journal.some(
        (line) => line.message?.includes(`[workflow:child-end]`) && line.message.includes(`status=cancelled`),
      ),
    ).toBe(true);
  });

  it("rejects a child source mutation immediately after snapshot start, before import or agent work", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const marker = path.join(root, "import-side-effect.txt");
    let calls = 0;
    let mutated = false;

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload",
      items: ["alpha"],
      outputDir: "outputs/source-race",
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
      onEvent: (line) => {
        if (mutated || !line.message?.includes("[workflow:child-start]")) return;
        mutated = true;
        writeWorkflow(
          root,
          "child",
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported\\n");\nexport default async (dsl) => dsl.agent("must not run");\n`,
        );
      },
    });

    expect(mutated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("source changed before execution");
    expect(calls).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.childRuns).toEqual([expect.objectContaining({ status: "failed", key: "alpha" })]);
    expect(result.journal.some((line) => line.message?.includes("[workflow:child-start]"))).toBe(true);
    expect(
      result.journal.some(
        (line) => line.message?.includes("[workflow:child-end]") && line.message.includes("status=failed"),
      ),
    ).toBe(true);
  });

  it("rejects direct and nested saved-workflow cycles before descendant agent work", async () => {
    const root = project();
    writeWorkflow(
      root,
      "self",
      `export default (dsl) => dsl.invokeWorkflow({ name: "self", key: "one", keys: ["one"], items: [], outputDir: dsl.outputDir() });\n`,
    );
    writeWorkflow(root, "grandchild", `export default async (dsl) => dsl.agent("must not run");\n`);
    writeWorkflow(
      root,
      "nested-child",
      `export default (dsl) => dsl.invokeWorkflow({ name: "grandchild", key: "one", keys: ["one"], items: [], outputDir: dsl.outputDir() });\n`,
    );
    writeWorkflow(
      root,
      "nested-parent",
      `export default (dsl) => dsl.invokeWorkflow({ name: "nested-child", key: "one", keys: ["one"], items: [], outputDir: dsl.outputDir() });\n`,
    );
    const harness = createHarness(root);
    let calls = 0;
    const createExecutor = executor(() => {
      calls += 1;
      return "must not run";
    });

    const direct = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "self",
      outputDir: "outputs/direct-cycle",
      createExecutor,
    });
    const nested = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "nested-parent",
      outputDir: "outputs/nested-cycle",
      createExecutor,
    });

    expect(direct.ok).toBe(false);
    expect(direct.error).toContain("cycle detected");
    expect(nested.ok).toBe(false);
    expect(nested.error).toContain("may not invoke another");
    expect(calls).toBe(0);
  });
});

describe("fenced output leases and atomic checkpoints", () => {
  it("retries the live mkdir-to-owner-write acquisition window", async () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/racing-owner", "unused", root);
    const leaseDir = path.join(workflowOutputStateDir(root, output.identity), "lease");
    const ownerFile = path.join(leaseDir, "owner.json");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
fs.mkdirSync(${JSON.stringify(leaseDir)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(ownerFile)}, "");
process.stdout.write("ready\\n");
setTimeout(() => fs.writeFileSync(${JSON.stringify(ownerFile)}, JSON.stringify({
  schema: "locus-pi.workflow-output-lease.v1",
  rootRunId: "racing-owner",
  outputDir: ${JSON.stringify(output.relativePath)},
  pid: process.pid,
  fencingToken: "racing-token",
  acquiredAt: new Date().toISOString(),
}) + "\\n"), 25);
setTimeout(() => process.exit(0), 150);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout!, "data");

    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "contender" })).toThrow(
      "owned by live run racing-owner",
    );
    await once(child, "exit");
  });

  it("conflicts for one live namespace while independent namespaces remain ownable", () => {
    const root = project();
    const firstOutput = resolveWorkflowOutputDirectory(root, "outputs/one", "unused", root);
    const secondOutput = resolveWorkflowOutputDirectory(root, "outputs/two", "unused", root);
    const first = acquireWorkflowRootLease({ projectRoot: root, output: firstOutput, rootRunId: "run-one" });

    expect(() =>
      acquireWorkflowRootLease({ projectRoot: root, output: firstOutput, rootRunId: "run-conflict" }),
    ).toThrow("owned by live run run-one");
    const independent = acquireWorkflowRootLease({
      projectRoot: root,
      output: secondOutput,
      rootRunId: "run-two",
    });

    releaseWorkflowRootLease(independent);
    releaseWorkflowRootLease(first);
  });

  it("keys leases by the physical output target across platform case aliases", () => {
    const root = project();
    const stored = resolveWorkflowOutputDirectory(root, "outputs/CaseAlias", "unused", root);
    const alias = resolveWorkflowOutputDirectory(root, "outputs/casealias", "unused", root);
    const first = acquireWorkflowRootLease({ projectRoot: root, output: stored, rootRunId: "stored-case" });

    if (alias.physicalPath === stored.physicalPath) {
      expect(alias.identity).toBe(stored.identity);
      expect(workflowOutputStateDir(root, alias.identity)).toBe(workflowOutputStateDir(root, stored.identity));
      expect(() => acquireWorkflowRootLease({ projectRoot: root, output: alias, rootRunId: "alias-case" })).toThrow(
        "owned by live run stored-case",
      );
    } else {
      expect(alias.identity).not.toBe(stored.identity);
      const independent = acquireWorkflowRootLease({ projectRoot: root, output: alias, rootRunId: "alias-case" });
      releaseWorkflowRootLease(independent);
    }

    releaseWorkflowRootLease(first);
  });

  it("reclaims a provably dead local owner and refuses an unreadable owner", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/reclaim", "unused", root);
    const state = workflowOutputStateDir(root, output.identity);
    const leaseDir = path.join(state, "lease");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      path.join(leaseDir, "owner.json"),
      `${JSON.stringify({
        schema: "locus-pi.workflow-output-lease.v1",
        rootRunId: "dead",
        outputDir: output.relativePath,
        pid: 2_147_483_647,
        fencingToken: "dead-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const reclaimed = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "replacement" });
    releaseWorkflowRootLease(reclaimed);

    mkdirSync(leaseDir);
    writeFileSync(path.join(leaseDir, "owner.json"), "not json\n", "utf8");
    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "blocked" })).toThrow(
      "verify no writer is active",
    );
  });

  it("fences a delayed former owner from checkpoint commit or release", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/fenced", "unused", root);
    const former = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "former" });
    releaseWorkflowRootLease(former);
    const current = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "current" });
    const checkpoint = {
      parentScriptSha256: "a".repeat(64),
      childScriptSha256: "b".repeat(64),
      outputDir: output.identity,
      itemKey: "item-one",
      childRunId: "child-one",
    };

    expect(() => commitWorkflowCompletedCheckpoint(former, checkpoint)).toThrow("fencing token is stale");
    expect(() => readWorkflowCompletedCheckpoint(former, checkpoint)).toThrow("fencing token is stale");
    expect(() => releaseWorkflowRootLease(former)).toThrow("fencing token is stale");
    expect(commitWorkflowCompletedCheckpoint(current, checkpoint)).toMatchObject({ status: "completed" });
    releaseWorkflowRootLease(current);
  });
});
