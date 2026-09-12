import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveWorkflowOutputDirectory,
  WORKFLOW_OUTPUT_LOCK_FILE,
  workflowOutputStateDir,
} from "../../../../extensions/workflows/runtime/workflow-output.js";
import {
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import * as workflowRunLayout from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import {
  readWorkflowRunResult,
  readWorkflowRunResultText,
  readWorkflowRunScriptSnapshot,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import * as workflowJournal from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../../test-harness.js";
import { executor, project, writeWorkflow, writeWorkflowTree } from "../../../fixtures/workflow-durable-project.js";

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

describe("saved child execution and item checkpoints", () => {
  it("binds packageName children to the Package source and rejects a project shadow", async () => {
    const parentSource = `export const meta = { name: "package-parent", profile: "standard" };
export default (dsl) => dsl.invokeWorkflow({
  packageName: "live-smoke",
  key: "package-smoke",
  keys: ["package-smoke"],
  input: "package child proof",
  outputDir: dsl.outputDir(),
});
`;

    const root = project();
    writeWorkflow(root, "package-parent", parentSource);
    const harness = createHarness(root);
    const calls: string[] = [];
    const exact = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "package-parent",
      outputDir: "outputs/package-child",
      createExecutor: executor((prompt) => {
        calls.push(prompt);
        return "package child completed";
      }),
    });

    expect(exact.ok, exact.error).toBe(true);
    expect(calls).toHaveLength(2);
    expect(exact.childRuns).toEqual([
      expect.objectContaining({ status: "completed", key: "package-smoke", childScriptSha256: expect.any(String) }),
    ]);
    const exactChild = JSON.parse(
      readFileSync(path.join(exact.childRuns![0]!.runDir!, "runtime", "result.json"), "utf8"),
    );
    expect(exactChild.target).toMatchObject({ kind: "name", ref: "live-smoke", source: "package" });

    const shadowRoot = project();
    writeWorkflow(shadowRoot, "package-parent", parentSource);
    writeWorkflow(shadowRoot, "live-smoke", `export default () => "project shadow";\n`);
    const shadowHarness = createHarness(shadowRoot);
    const shadowCalls: string[] = [];
    const shadowed = await runWorkflowScript({
      pi: shadowHarness.pi,
      ctx: shadowHarness.ctx,
      signal: new AbortController().signal,
      name: "package-parent",
      outputDir: "outputs/package-shadow",
      createExecutor: executor((prompt) => {
        shadowCalls.push(prompt);
        return "must not run";
      }),
    });

    expect(shadowed.ok).toBe(false);
    expect(shadowed.error).toContain("saved child workflow source changed before execution");
    expect(shadowCalls).toEqual([]);
  });

  it("binds child to the running root folder and records its qualified identity", async () => {
    const root = project();
    writeWorkflowTree(root, "composed", {
      composed: `export const meta = { name: "composed", profile: "standard" };
export default (dsl) => dsl.invokeWorkflow({
  child: "worker",
  key: "worker",
  keys: ["worker"],
  input: "owned child",
  outputDir: dsl.outputDir(),
});
`,
      worker: `export const meta = { name: "composed/worker", profile: "standard" };
export default (dsl, input) => dsl.agent(input);
`,
    });
    const harness = createHarness(root);
    const calls: string[] = [];
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed",
      outputDir: "outputs/composed",
      createExecutor: executor((prompt) => {
        calls.push(prompt);
        return "done";
      }),
    });

    expect(result.ok, result.error).toBe(true);
    expect(calls).toEqual(["owned child"]);
    expect(readWorkflowRunSummary(root, result.runId!).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(root, result.runId!)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref: "composed", source: "project" },
    });
    const childRunId = result.childRuns![0]!.runId!;
    const child = readWorkflowRunResult(root, childRunId);
    if (child === null) throw new Error("composed child result was not persisted");
    expect(child.target).toMatchObject({ kind: "name", ref: "composed/worker", source: "project" });
    expect(readWorkflowRunSummary(root, childRunId).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(root, childRunId)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref: "composed/worker", source: "project" },
    });
    const childArtifacts = readWorkflowArtifactIndex(root, childRunId);
    if (childArtifacts.status !== "ready") throw new Error(childArtifacts.message);
    const answerRef = childArtifacts.index.artifacts.find((artifact) => artifact.kind === "answer");
    if (answerRef === undefined) throw new Error("composed child answer was not persisted");
    expect(readWorkflowArtifactRecord(root, childRunId, answerRef.artifactId)).toMatchObject({
      status: "ready",
      bytes: Buffer.from("done"),
    });

    const direct = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed/worker",
      input: "direct child",
      createExecutor: executor(() => "direct done"),
    });
    expect(direct.ok, direct.error).toBe(true);
    expect(direct.workspaceDirRelative).toBe(`.locus-pi/workspaces/${direct.runId}-composed-worker`);
    expect(readWorkflowRunSummary(root, direct.runId!).status).toBe("completed");
    expect(readWorkflowRunScriptSnapshot(root, direct.runId!)).toMatchObject({
      kind: "ready",
      target: { kind: "name", ref: "composed/worker", source: "project" },
    });
  });

  it("resumes a qualified child in its persisted pre-upgrade default workspace", async () => {
    const root = project();
    writeWorkflowTree(root, "composed", {
      worker: `export const meta = { name: "composed/worker", profile: "standard" };
export default (dsl) => dsl.outputDir();
`,
    });
    const harness = createHarness(root);
    const legacyWorkspace = "tmp/composed";
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed/worker",
      outputDir: legacyWorkspace,
    });
    expect(first.ok, first.error).toBe(true);

    const persisted = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    writeFileSync(
      workflowResultFile(first.runDir),
      `${JSON.stringify({ ...persisted, workspaceDirExplicit: false })}\n`,
      "utf8",
    );

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "composed/worker",
      resumeFromRunId: first.runId,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe(legacyWorkspace);
  });

  it("does not implicitly reuse a persisted workspace for a different workflow target", async () => {
    const root = project();
    writeWorkflow(root, "alpha", `export default (dsl) => dsl.outputDir();\n`);
    writeWorkflow(root, "beta", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "alpha",
    });
    expect(first.ok, first.error).toBe(true);
    const originalReadme = readFileSync(path.join(first.runDir, "README.md"), "utf8");
    const originalBacklink = readFileSync(path.join(first.workspaceDir!, ".workflow-runs.md"), "utf8");

    let calls = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "beta",
      resumeFromRunId: first.runId,
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("outputDir must equal the source workspace");
    expect(resumed.runDir).toBe(path.join(first.runDir, "attempts", resumed.runId));
    expect(resumed.resultPersistence.ok).toBe(true);
    expect(readFileSync(path.join(first.runDir, "README.md"), "utf8")).toBe(originalReadme);
    expect(readFileSync(path.join(first.workspaceDir!, ".workflow-runs.md"), "utf8")).toBe(originalBacklink);
    expect(calls).toBe(0);
    expect(existsSync(path.join(root, "tmp", "beta"))).toBe(false);
  });

  it("skips changed opaque payload in one namespace but runs it in a fresh namespace", async () => {
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

    const freshCalls: string[] = [];
    const fresh = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-two",
      items: ["alpha", "beta"],
      outputDir: "outputs/fresh",
      createExecutor: executor((prompt) => {
        freshCalls.push(prompt);
        const payload = prompt.slice("write:".length);
        const key = payload.slice(payload.lastIndexOf(":") + 1);
        writeFileSync(path.join(root, "outputs", "fresh", `${key}.md`), `${payload}\n`, "utf8");
        return "written";
      }),
    });

    expect(fresh.ok, fresh.error).toBe(true);
    expect(freshCalls).toEqual(["write:payload-two:alpha", "write:payload-two:beta"]);
    expect(fresh.childRuns).toEqual([
      expect.objectContaining({ status: "completed", key: "alpha" }),
      expect.objectContaining({ status: "completed", key: "beta" }),
    ]);
    expect(readFileSync(path.join(root, "outputs", "fresh", "alpha.md"), "utf8")).toBe("payload-two:alpha\n");
  });

  it("binds resume to the source workspace when the same namespace is supplied", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const outputDir = "outputs/resume-source";
    const harness = createHarness(root);
    const calls: string[] = [];
    const createExecutor = executor((prompt) => {
      calls.push(prompt);
      const key = prompt.slice(prompt.lastIndexOf(":") + 1);
      writeFileSync(path.join(root, outputDir, `${key}.md`), `${prompt}\n`, "utf8");
      return "written";
    });

    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-one",
      items: ["alpha"],
      outputDir,
      createExecutor,
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspaceDirRelative).toBe(outputDir);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "parent",
      input: "payload-one",
      items: ["alpha"],
      outputDir,
      resumeFromRunId: first.runId,
      createExecutor,
    });

    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe(outputDir);
    expect(calls).toEqual([]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha", sourceRunId: first.childRuns?.[0]?.runId }),
    ]);
  });

  it("requires repeating an explicit outputDir even when it equals the default", async () => {
    const root = project();
    writeWorkflow(root, "default-resume", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const outputDir = "tmp/default-resume";
    const run = (options: { outputDir?: string; resumeFromRunId?: string } = {}) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "default-resume",
        ...options,
      });

    const first = await run({ outputDir });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspaceDirRelative).toBe(outputDir);
    expect(first.workspaceDirExplicit).toBe(true);
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspaceDirRelative: outputDir,
      workspaceDirExplicit: true,
    });

    const omitted = await run({ resumeFromRunId: first.runId });
    expect(omitted.ok).toBe(false);
    expect(omitted.error).toContain("source workspace was selected explicitly");

    const repeated = await run({ outputDir, resumeFromRunId: first.runId });
    expect(repeated.ok, repeated.error).toBe(true);
    expect(repeated.workspaceDirRelative).toBe(outputDir);
    expect(repeated.workspaceDirExplicit).toBe(true);
  });

  it("fails generic resume when a v2 source identity loses its persisted target", async () => {
    const root = project();
    writeWorkflow(root, "generic-v2-target", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "generic-v2-target",
      outputDir: "outputs/generic-v2-target",
    });
    expect(first.ok, first.error).toBe(true);
    const result = JSON.parse(readFileSync(first.resultPersistence.path, "utf8")) as Record<string, unknown>;
    delete result.target;
    writeFileSync(first.resultPersistence.path, `${JSON.stringify(result)}\n`, "utf8");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "generic-v2-target",
      outputDir: "outputs/generic-v2-target",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
    expect(resumed.childRuns ?? []).toEqual([]);
  });

  it.each(["true", 1, null])("fails closed when persisted workspaceDirExplicit has wrong type %j", async (value) => {
    const root = project();
    writeWorkflow(root, "malformed-explicit", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const outputDir = "tmp/malformed-explicit";
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "malformed-explicit",
      outputDir,
    });
    const resultPath = first.resultPersistence.path;
    const persisted = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    persisted.workspaceDirExplicit = value;
    writeFileSync(resultPath, `${JSON.stringify(persisted)}\n`, "utf8");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "malformed-explicit",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
  });

  it("binds post-code-review resume to exact semantic input before checkpoints", async () => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "post-code-review", PARENT);
    const harness = createHarness(root);
    const outputDir = "outputs/post-code-review-input";
    let calls = 0;
    const createExecutor = executor((prompt) => {
      calls += 1;
      mkdirSync(path.join(root, outputDir), { recursive: true });
      writeFileSync(path.join(root, outputDir, "alpha.md"), `${prompt}\n`, "utf8");
      return `written:${prompt}`;
    });
    const run = (input: string, resumeFromRunId?: string, namespace = outputDir) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        input,
        items: ["alpha"],
        outputDir: namespace,
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor,
      });

    const first = await run("review alpha");
    expect(first.ok, first.error).toBe(true);
    expect(first.semanticInputPresent).toBe(true);
    expect(first.semanticInputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      semanticInputPresent: true,
      semanticInputSha256: first.semanticInputSha256,
    });
    const firstCalls = calls;

    const same = await run("review alpha", first.runId);
    expect(same.ok, same.error).toBe(true);
    expect(calls).toBe(firstCalls);
    expect(same.childRuns).toEqual([expect.objectContaining({ status: "skipped", key: "alpha" })]);

    const changed = await run("review beta", first.runId);
    expect(changed.ok).toBe(false);
    expect(changed.error).toContain("semantic input differs");
    expect(changed.childRuns ?? []).toEqual([]);
    expect(changed.primaryFile).toBeUndefined();
    expect(changed.primaryOutputPath).toBeUndefined();
    expect(calls).toBe(firstCalls);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it("uses one persisted resume binding for workspace, owner, semantic, and replay checks", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const outputDir = "outputs/resume-binding";
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "resume binding",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);

    const originalResolve = workflowRunLayout.resolveWorkflowRunDir;
    const duplicateGroup = path.join(root, ".locus-pi", "runs", "duplicate-binding-group");
    const resolve = vi.spyOn(workflowRunLayout, "resolveWorkflowRunDir").mockImplementation((projectRoot, runId) => {
      const resolved = originalResolve(projectRoot, runId);
      mkdirSync(path.join(duplicateGroup, "children", runId), { recursive: true });
      return resolved;
    });
    const resolvedRunDir = workflowRunLayout.resolveWorkflowRunDir(root, first.runId);
    expect(readWorkflowLaunchBinding(root, first.runId, resolvedRunDir)).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockRestore();
    rmSync(duplicateGroup, { recursive: true, force: true });

    const readSpy = vi.spyOn(workflowJournal, "readWorkflowRunResult");
    try {
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        input: "resume binding",
        outputDir,
        resumeFromRunId: first.runId,
      });
      expect(resumed.ok, resumed.error).toBe(true);
      // The post-target binding is the only direct result read; summary status
      // uses its journal-owned projection and replay reuses this binding.
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects a valid-looking result projection rewrite before owner resume work", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const outputDir = "outputs/launch-binding-result-tamper";
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);
    expect(existsSync(workflowLaunchBindingFile(first.runDir))).toBe(true);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspaceDir = path.join(root, "outputs", "launch-binding-result-tamper-other");
    raw.workspaceDirRelative = "outputs/launch-binding-result-tamper-other";
    raw.workspacePhysicalIdentity = "outputs/launch-binding-result-tamper-other";
    raw.semanticInputSha256 = "a".repeat(64);
    raw.target = { kind: "name", ref: "ordinary", source: "project" };
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");

    let calls = 0;
    const resumed = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
      resumeFromRunId: first.runId,
      createExecutor: executor(() => {
        calls += 1;
        return "must not run";
      }),
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/no valid host launch binding|malformed persisted metadata/u);
    expect(resumed.childRuns ?? []).toEqual([]);
    expect(calls).toBe(0);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it("rejects a tampered host launch binding before owner resume work", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const outputDir = "outputs/launch-binding-sidecar-tamper";
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);

    const bindingPath = workflowLaunchBindingFile(first.runDir);
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as {
      semanticInput: { sha256: string };
    };
    binding.semanticInput.sha256 = "b".repeat(64);
    writeFileSync(bindingPath, JSON.stringify(binding), "utf8");

    const resumed = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "original",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("no valid host launch binding");
    expect(resumed.childRuns ?? []).toEqual([]);
    expect(existsSync(path.join(root, outputDir, WORKFLOW_OUTPUT_LOCK_FILE))).toBe(false);
  });

  it.each([
    {
      label: "wrong snapshot bytes",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        const identity = binding.scriptIdentity as Record<string, unknown>;
        chmodSync(identity.snapshotPath as string, 0o644);
        writeFileSync(identity.snapshotPath as string, "wrong bytes\n", "utf8");
      },
    },
    {
      label: "external snapshot symlink",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        const identity = binding.scriptIdentity as Record<string, unknown>;
        rmSync(identity.snapshotPath as string, { force: true });
        symlinkSync("/etc/hosts", identity.snapshotPath as string);
      },
    },
    {
      label: "malformed target source",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        binding.target = { kind: "name", ref: "post-code-review", source: "unknown" };
      },
    },
    {
      label: "unsorted dependencies",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.scriptIdentity as Record<string, unknown>).builtinImports = ["node:z", "node:a"];
      },
    },
    {
      label: "invalid builtin dependency",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.scriptIdentity as Record<string, unknown>).builtinImports = ["fs"];
      },
    },
    {
      label: "missing workspace",
      mutate: (root: string, binding: Record<string, unknown>) => {
        const workspace = binding.workspace as Record<string, unknown>;
        workspace.absolutePath = path.join(root, "outputs", "missing-workspace");
        workspace.relativePath = "outputs/missing-workspace";
        workspace.physicalPath = workspace.absolutePath;
        workspace.physicalIdentity = workspace.relativePath;
      },
    },
    {
      label: "workspace is a file",
      mutate: (root: string, binding: Record<string, unknown>) => {
        const workspace = binding.workspace as Record<string, unknown>;
        const filePath = path.join(root, "outputs", "workspace-file");
        writeFileSync(filePath, "not a directory\n", "utf8");
        workspace.absolutePath = filePath;
        workspace.relativePath = "outputs/workspace-file";
        workspace.physicalPath = filePath;
        workspace.physicalIdentity = workspace.relativePath;
      },
    },
    {
      label: "mismatched workspace physical identity",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.workspace as Record<string, unknown>).physicalIdentity = "outputs/other-workspace";
      },
    },
    {
      label: "extra semantic key",
      mutate: (_root: string, binding: Record<string, unknown>) => {
        (binding.semanticInput as Record<string, unknown>).extra = true;
      },
    },
  ])("rejects launch binding with $label before handoff/resume use", async ({ mutate }) => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const outputDir = "outputs/launch-binding-validation";
    const first = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "validation",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);
    const bindingPath = workflowLaunchBindingFile(first.runDir);
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    mutate(root, binding);
    writeFileSync(bindingPath, `${JSON.stringify(binding)}\n`, "utf8");

    expect(readWorkflowLaunchBinding(root, first.runId)).toBeNull();
    const resumed = await runWorkflowScript({
      pi: createHarness(root).pi,
      ctx: createHarness(root).ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "validation",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("no valid host launch binding");
    expect(resumed.childRuns ?? []).toEqual([]);
  });

  it.each([undefined, "outputs/resume-other"] as const)(
    "fails resume before child work when outputDir is %s instead of the source workspace",
    async (outputDir) => {
      const root = project();
      writeWorkflow(root, "child", CHILD);
      writeWorkflow(root, "parent", PARENT);
      const sourceOutputDir = "outputs/resume-source";
      const harness = createHarness(root);
      const createExecutor = executor((prompt) => {
        const key = prompt.slice(prompt.lastIndexOf(":") + 1);
        writeFileSync(path.join(root, sourceOutputDir, `${key}.md`), `${prompt}\n`, "utf8");
        return "written";
      });

      const first = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload-one",
        items: ["alpha"],
        outputDir: sourceOutputDir,
        createExecutor,
      });
      expect(first.ok, first.error).toBe(true);

      let calls = 0;
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload-one",
        items: ["alpha"],
        ...(outputDir === undefined ? {} : { outputDir }),
        resumeFromRunId: first.runId,
        createExecutor: executor(() => {
          calls += 1;
          return "must not run";
        }),
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.error).toContain(
        outputDir === undefined
          ? "source workspace was selected explicitly"
          : "outputDir must equal the source workspace",
      );
      expect(calls).toBe(0);
      const candidateRelative = outputDir ?? "tmp/parent";
      expect(existsSync(path.join(root, candidateRelative))).toBe(false);
      expect(existsSync(workflowOutputStateDir(root, candidateRelative))).toBe(false);
      expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
        ok: false,
        disposition: { status: "failed" },
        error: resumed.error,
      });
    },
  );

  it("fails resume when the source result has no persisted workspace identity", async () => {
    const root = project();
    writeWorkflow(root, "resume-missing-workspace", `export default () => "ok";\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-missing-workspace",
      outputDir: "outputs/source",
    });
    expect(first.ok, first.error).toBe(true);

    const persisted = readWorkflowRunResult(root, first.runId);
    if (persisted === null) throw new Error("expected persisted source result");
    const { workspaceDir: _workspaceDir, workspaceDirRelative: _workspaceDirRelative, ...withoutWorkspace } = persisted;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(withoutWorkspace), "utf8");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "resume-missing-workspace",
      outputDir: "outputs/source",
      resumeFromRunId: first.runId,
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
    expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
      ok: false,
      disposition: { status: "failed" },
      error: resumed.error,
    });
  });

  it("keeps removed workspaces readable while resume fails physical identity preflight", async () => {
    const root = project();
    writeWorkflow(root, "removed-workspace", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "removed-workspace",
      outputDir: "outputs/removed-workspace",
    });
    expect(first.ok, first.error).toBe(true);
    rmSync(first.workspaceDir!, { recursive: true, force: true });

    const persistedAfterRemoval = readWorkflowRunResult(root, first.runId);
    expect(persistedAfterRemoval).toMatchObject({
      workspaceDir: path.join(root, "outputs", "removed-workspace"),
      workspaceDirRelative: "outputs/removed-workspace",
    });
    expect(persistedAfterRemoval).not.toHaveProperty("workspaceDirInvalid");
    expect(readWorkflowRunResultText(root, first.runId)).toMatchObject({ status: "ready" });
    expect(readWorkflowRunSummary(root, first.runId).status).toBe("completed");

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "removed-workspace",
      outputDir: "outputs/removed-workspace",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("workspace identity is unavailable");
    expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
      ok: false,
      disposition: { status: "failed" },
    });
  });

  it("fails closed when persisted workspaceDir is relative", async () => {
    const root = project();
    writeWorkflow(root, "relative-workspace", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "relative-workspace",
      outputDir: "outputs/relative-workspace",
    });
    expect(first.ok, first.error).toBe(true);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspaceDir = "outputs/relative-workspace";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspaceDirInvalid: expect.stringContaining("absolute path"),
    });

    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "relative-workspace",
      outputDir: "outputs/relative-workspace",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
    expect(readWorkflowRunResult(root, resumed.runId)).toMatchObject({
      ok: false,
      disposition: { status: "failed" },
    });
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
    const run = (resumeFromRunId?: string) =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha", "beta"],
        outputDir: "outputs/retry",
        ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
        createExecutor,
      });

    const interrupted = await run();
    expect(interrupted.ok).toBe(false);
    expect(calls).toEqual(["write:payload:alpha", "write:payload:beta"]);

    calls.length = 0;
    failBeta = false;
    const resumed = await run(interrupted.runId);
    expect(resumed.ok, resumed.error).toBe(true);
    expect(calls).toEqual(["write:payload:beta"]);
    expect(resumed.childRuns).toEqual([
      expect.objectContaining({ status: "skipped", key: "alpha" }),
      expect.objectContaining({ status: "completed", key: "beta" }),
    ]);
    expect(resumed.storageRootRunId).toBe(interrupted.runId);
    expect(resumed.runDir).toBe(path.join(interrupted.runDir, "attempts", resumed.runId));
    expect(resumed.lineage).toEqual({ rootRunId: resumed.runId, depth: 0 });
    const retriedChild = resumed.childRuns![1]!;
    expect(retriedChild.runDir).toBe(path.join(interrupted.runDir, "children", retriedChild.runId!));
    const childEnvelope = JSON.parse(readFileSync(workflowResultFile(retriedChild.runDir!), "utf8"));
    expect(childEnvelope.storageRootRunId).toBe(interrupted.runId);
    expect(childEnvelope.lineage.rootRunId).toBe(resumed.runId);
    expect(readWorkflowRunScriptSnapshot(root, retriedChild.runId!)).toMatchObject({ kind: "ready" });
    const resumedAgain = await run(resumed.runId);
    expect(resumedAgain.ok, resumedAgain.error).toBe(true);
    expect(resumedAgain.runDir).toBe(path.join(interrupted.runDir, "attempts", resumedAgain.runId));
    expect(resumedAgain.childRuns!.every((child) => child.status === "skipped")).toBe(true);

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

  it.each([
    ["missing", undefined],
    ["null", null],
    ["object", { runId: "child" }],
    ["whitespace", " child"],
    ["control", "child\u0001run"],
    ["overlong", "a".repeat(129)],
  ] as const)("quarantines a checkpoint with %s childRunId and reruns the child", async (_label, childRunId) => {
    const root = project();
    writeWorkflow(root, "child", CHILD);
    writeWorkflow(root, "parent", PARENT);
    const harness = createHarness(root);
    const stableFile = path.join(root, "outputs", "invalid-child-run-id", "alpha.md");
    let calls = 0;
    const run = () =>
      runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "parent",
        input: "payload",
        items: ["alpha"],
        outputDir: "outputs/invalid-child-run-id",
        createExecutor: executor(() => {
          calls += 1;
          writeFileSync(stableFile, `version ${calls}\n`, "utf8");
          return "written";
        }),
      });

    expect((await run()).ok).toBe(true);
    const output = resolveWorkflowOutputDirectory(root, "outputs/invalid-child-run-id", "unused", root);
    const checkpoints = path.join(workflowOutputStateDir(root, output.identity), "checkpoints");
    const checkpointFile = path.join(
      checkpoints,
      readdirSync(checkpoints).find((name) => name.endsWith(".json"))!,
    );
    const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8")) as Record<string, unknown>;
    if (childRunId === undefined) delete checkpoint.childRunId;
    else checkpoint.childRunId = childRunId;
    writeFileSync(checkpointFile, `${JSON.stringify(checkpoint)}\n`, "utf8");

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
            agentName: request.agent?.name ?? "sub-agent",
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
