import { spawn } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  acquireWorkflowRootLease,
  assertWorkflowOutputDirPath,
  assertWorkflowPhysicalWorkspaceIdentity,
  commitWorkflowCompletedCheckpoint,
  readWorkflowCompletedCheckpoint,
  referenceWorkflowPrimaryFile,
  releaseWorkflowRootLease,
  resolveWorkflowOutputDirectory,
  workflowOutputStateDir,
} from "../../../extensions/workflows/runtime/workflow-output.js";
import {
  readWorkflowRunResult,
  readWorkflowRunResultText,
  readWorkflowRunSummary,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import * as workflowJournal from "../../../extensions/workflows/runtime/workflow-journal.js";
import { workflowResultFile } from "../../../extensions/workflows/runtime/workflow-result.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingFile,
} from "../../../extensions/workflows/runtime/workflow-launch-binding.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { resolveWorkflowTarget } from "../../../extensions/workflows/runtime/workflow-runner.js";
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
  it("does not re-resolve a host-bound target after source precedence changes", async () => {
    const root = project();
    const piWorkflow = path.join(root, ".pi", "workflows", "switch.workflow.mjs");
    writeWorkflow(root, "switch", `export default () => "project-source";\n`);
    const target = resolveWorkflowTarget({ name: "switch" }, root, root);
    rmSync(piWorkflow);
    mkdirSync(path.join(root, ".claude", "workflows"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "workflows", "switch.workflow.mjs"), 'export default () => "shadow";\n');

    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      targetBinding: target,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing|snapshot|target|ENOENT/u);
    expect(result.result).not.toBe("shadow");
  });

  it.each([
    { kind: "name", ref: "switch", source: "personal", path: "PLACEHOLDER" },
    { kind: "name", ref: "other", source: "project", path: "PLACEHOLDER" },
  ])("rejects forged target binding %j", async (forged) => {
    const root = project();
    writeWorkflow(root, "switch", `export default () => "project-source";\n`);
    const target = resolveWorkflowTarget({ name: "switch" }, root, root);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      targetBinding: { ...forged, path: target.path } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/binding|source|request/u);
  });

  it("rejects a target binding whose path ancestor is a symlink", async () => {
    const root = project();
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-bound-target-"));
    writeFileSync(path.join(outside, "switch.workflow.mjs"), 'export default () => "outside";\n');
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    rmSync(path.join(root, ".pi", "workflows"), { recursive: true, force: true });
    symlinkSync(outside, path.join(root, ".pi", "workflows"), "dir");
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      targetBinding: {
        kind: "name",
        ref: "switch",
        source: "project",
        path: path.join(root, ".pi", "workflows", "switch.workflow.mjs"),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symlink|binding|canonical/u);
  });

  it("accepts an internally confined target symlink after physical proof", async () => {
    const root = project();
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    const real = path.join(root, ".pi", "workflows", "switch.workflow.mjs");
    const alias = path.join(root, ".pi", "workflows", "alias.workflow.mjs");
    writeFileSync(real, 'export default () => "project-source";\n');
    symlinkSync(real, alias);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      scriptPath: ".pi/workflows/alias.workflow.mjs",
      targetBinding: {
        kind: "scriptPath",
        ref: ".pi/workflows/alias.workflow.mjs",
        source: "project",
        path: alias,
      },
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toBe("project-source");
  });

  it("rejects a target binding when multiple public target fields are supplied", async () => {
    const root = project();
    writeWorkflow(root, "switch", `export default () => "project-source";\n`);
    const target = resolveWorkflowTarget({ name: "switch" }, root, root);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "switch",
      scriptPath: "switch.workflow.mjs",
      targetBinding: target,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exactly one public target field");
  });

  it("keeps generated physical identity grammar separate from explicit outputDir grammar", () => {
    expect(() => assertWorkflowOutputDirPath("packages/docs site/tmp/files")).toThrow();
    expect(assertWorkflowPhysicalWorkspaceIdentity("packages/docs site/tmp/files")).toBe(
      "packages/docs site/tmp/files",
    );
    expect(assertWorkflowPhysicalWorkspaceIdentity("p".repeat(401))).toHaveLength(401);
    for (const invalid of ["", "/outside", "a\\b", "a\0b", ".", "..", "a/../b", "a//b", "a/./b"]) {
      expect(() => assertWorkflowPhysicalWorkspaceIdentity(invalid)).toThrow();
    }
  });

  it("requires an explicit fresh namespace for post-code-review", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default () => "ok";\n`);
    const harness = createHarness(root);

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fresh launch requires an explicit project-relative outputDir");
    expect(existsSync(path.join(root, "tmp", "post-code-review"))).toBe(false);
  });

  it("rejects fresh post-code-review reuse while allowing exact resume", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "first semantic target",
      outputDir: "tmp/post-code-review/review-one",
    });
    expect(first.ok, first.error).toBe(true);

    const secondHarness = createHarness(root);
    const fresh = await runWorkflowScript({
      pi: secondHarness.pi,
      ctx: secondHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "different semantic target",
      outputDir: "tmp/post-code-review/review-one",
    });
    expect(fresh.ok).toBe(false);
    expect(fresh.error).toContain("already has durable state");

    const distinctHarness = createHarness(root);
    const distinct = await runWorkflowScript({
      pi: distinctHarness.pi,
      ctx: distinctHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "different semantic target",
      outputDir: "tmp/post-code-review/review-two",
    });
    expect(distinct.ok, distinct.error).toBe(true);

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "first semantic target",
      outputDir: "tmp/post-code-review/review-one",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok, resumed.error).toBe(true);
    expect(resumed.workspaceDirRelative).toBe("tmp/post-code-review/review-one");
  });

  it("does not recreate a removed workspace when fresh owner state rejects", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "first semantic target",
      outputDir: "tmp/post-code-review/removed-workspace",
    });
    expect(first.ok, first.error).toBe(true);
    rmSync(path.join(root, "tmp", "post-code-review"), { recursive: true, force: true });

    const freshHarness = createHarness(root);
    const fresh = await runWorkflowScript({
      pi: freshHarness.pi,
      ctx: freshHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "second semantic target",
      outputDir: "tmp/post-code-review/removed-workspace",
    });
    expect(fresh.ok).toBe(false);
    expect(fresh.error).toContain("already has durable state");
    expect(existsSync(path.join(root, "tmp", "post-code-review"))).toBe(false);
  });

  it("binds an absolute owner path to owner metadata and semantic input on resume", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const scriptPath = path.join(root, ".pi", "workflows", "post-code-review.workflow.mjs");
    const outputDir = "tmp/post-code-review/absolute-owner";
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      scriptPath,
      input: "review alpha",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.semanticInputPresent).toBe(true);
    expect(first.semanticInputSha256).toMatch(/^[a-f0-9]{64}$/u);

    const changedHarness = createHarness(root);
    const changed = await runWorkflowScript({
      pi: changedHarness.pi,
      ctx: changedHarness.ctx,
      signal: new AbortController().signal,
      scriptPath,
      input: "review beta",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(changed.ok).toBe(false);
    expect(changed.error).toContain("semantic input differs");
  });

  it("refuses resume from a copied result envelope bound to another run", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "review alpha",
      outputDir: "tmp/post-code-review/copied-source",
    });
    expect(first.ok, first.error).toBe(true);

    const copiedRunId = "20260713-010103-copied-resume";
    const copiedRunDir = path.join(root, ".pi", "locus-pi", "runs", copiedRunId);
    mkdirSync(path.join(copiedRunDir, "runtime"), { recursive: true });
    writeFileSync(workflowResultFile(copiedRunDir), readFileSync(workflowResultFile(first.runDir), "utf8"), "utf8");

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      input: "review alpha",
      outputDir: "tmp/post-code-review/copied-source",
      resumeFromRunId: copiedRunId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/persisted result envelope|malformed persisted metadata/u);
  });

  it("persists a project-relative physical workspace identity and rejects malformed post-code-review resume evidence", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const harness = createHarness(root);
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspacePhysicalIdentity).toBe("tmp/post-code-review/review-identity");
    expect(first.workspacePhysicalIdentitySchemaVersion).toBe(1);
    expect(first.workspacePhysicalIdentity).not.toContain(root);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspacePhysicalIdentity = "../outside";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspacePhysicalIdentityInvalid: expect.stringContaining("unsafe path component"),
    });

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("physical identity is malformed");

    raw.workspacePhysicalIdentity = first.workspacePhysicalIdentity;
    raw.workspacePhysicalIdentitySchemaVersion = 2;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const schemaResumeHarness = createHarness(root);
    const schemaResumed = await runWorkflowScript({
      pi: schemaResumeHarness.pi,
      ctx: schemaResumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(schemaResumed.ok).toBe(false);
    expect(schemaResumed.error).toContain("physical identity schema");

    delete raw.workspacePhysicalIdentitySchemaVersion;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const identityOnlyHarness = createHarness(root);
    const identityOnlyResumed = await runWorkflowScript({
      pi: identityOnlyHarness.pi,
      ctx: identityOnlyHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(identityOnlyResumed.ok).toBe(false);
    expect(identityOnlyResumed.error).toContain("physical identity schema");

    raw.workspacePhysicalIdentitySchemaVersion = 1;
    delete raw.workspacePhysicalIdentity;
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const schemaOnlyHarness = createHarness(root);
    const schemaOnlyResumed = await runWorkflowScript({
      pi: schemaOnlyHarness.pi,
      ctx: schemaOnlyHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity",
      resumeFromRunId: first.runId,
    });
    expect(schemaOnlyResumed.ok).toBe(false);
    expect(schemaOnlyResumed.error).toContain("workspace physical identity is required");
  });

  it("uses the persisted generated workspace identity when resuming a default workspace with spaces", async () => {
    const root = project();
    const workingDirectory = path.join(root, "packages", "docs site");
    mkdirSync(workingDirectory, { recursive: true });
    writeWorkflow(root, "default-space", `export default (dsl) => dsl.outputDir();\n`);
    const sourceHarness = createHarness(root);
    sourceHarness.ctx.session = { ...sourceHarness.ctx.session!, workingDirectory };
    const first = await runWorkflowScript({
      pi: sourceHarness.pi,
      ctx: sourceHarness.ctx,
      signal: new AbortController().signal,
      name: "default-space",
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.workspacePhysicalIdentity).toBe("packages/docs site/tmp/default-space");
    expect(readWorkflowRunResult(root, first.runId)).toMatchObject({
      workspacePhysicalIdentity: "packages/docs site/tmp/default-space",
    });

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspacePhysicalIdentity = "packages/docs site/tmp/other";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");
    const resumeHarness = createHarness(root);
    resumeHarness.ctx.session = { ...resumeHarness.ctx.session!, workingDirectory };
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "default-space",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
  });

  it("rejects post-code-review resume when the recorded physical identity changed", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity-change",
    });
    expect(first.ok, first.error).toBe(true);

    const raw = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
    raw.workspacePhysicalIdentity = "tmp/post-code-review/replaced-identity";
    writeFileSync(workflowResultFile(first.runDir), JSON.stringify(raw), "utf8");

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir: "tmp/post-code-review/review-identity-change",
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toContain("malformed persisted metadata");
  });

  it("fails closed when a post-code-review workspace ancestor is physically replaced", async () => {
    const root = project();
    writeWorkflow(root, "post-code-review", `export default (dsl) => dsl.outputDir();\n`);
    const firstHarness = createHarness(root);
    const outputDir = "tmp/post-code-review/review-replaced";
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir,
    });
    expect(first.ok, first.error).toBe(true);

    const outside = mkdtempSync(path.join(tmpdir(), "workflow-post-review-replaced-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const workspaceParent = path.join(root, "tmp", "post-code-review");
    rmSync(workspaceParent, { recursive: true, force: true });
    symlinkSync(outside, workspaceParent, "dir");

    const resumeHarness = createHarness(root);
    const resumed = await runWorkflowScript({
      pi: resumeHarness.pi,
      ctx: resumeHarness.ctx,
      signal: new AbortController().signal,
      name: "post-code-review",
      outputDir,
      resumeFromRunId: first.runId,
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.error).toMatch(/symlink|physical|outputDir|unavailable|binding/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(workspaceParent, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

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

  it("rejects an overlong component-valid outputDir before an agent starts", async () => {
    const root = project();
    writeWorkflow(root, "empty", `export default () => "ok";\n`);
    let calls = 0;
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "empty",
      outputDir: `${"a".repeat(200)}/${"b".repeat(200)}`,
      createExecutor: executor(() => {
        calls += 1;
        return "unused";
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outputDir exceeds 400 characters");
    expect(calls).toBe(0);
  });

  it.each([null, true, 1, [], { path: "outputs/task" }])(
    "terminalizes non-string direct outputDir %j before child work",
    async (outputDir) => {
      const root = project();
      writeWorkflow(root, "empty", `export default async (dsl) => dsl.agent("must not run");\n`);
      let calls = 0;
      const harness = createHarness(root);

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "empty",
        outputDir: outputDir as unknown as string,
        createExecutor: executor(() => {
          calls += 1;
          return "unused";
        }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("workflow outputDir must be a non-empty trimmed path");
      expect(calls).toBe(0);
      expect(readWorkflowRunResult(root, result.runId)).toMatchObject({
        ok: false,
        disposition: { status: "failed" },
        error: result.error,
      });
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

  it("rejects a workspace ancestor replaced by an external symlink before primary open", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/primary-ancestor", "primary-ancestor", root);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-primary-outside-"));
    writeFileSync(path.join(outside, "plan.md"), "outside\n", "utf8");
    rmSync(output.absolutePath, { recursive: true, force: true });
    symlinkSync(outside, output.absolutePath, "dir");

    expect(() => referenceWorkflowPrimaryFile(output, "plan.md")).toThrow(/physical outputDir|workspace changed/u);

    rmSync(outside, { recursive: true, force: true });
  });
});

describe("checkpoint path confinement", () => {
  const identity = {
    parentScriptSha256: "a".repeat(64),
    childScriptSha256: "b".repeat(64),
    outputDir: "outputs/checkpoint-confinement",
    itemKey: "item-one",
    childRunId: "child-one",
  };

  it("rejects a valid-looking checkpoint behind an external checkpoints ancestor", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, identity.outputDir, "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "checkpoint-root" });
    const checkpoint = commitWorkflowCompletedCheckpoint(lease, identity);
    const checkpoints = path.join(lease.stateDir, "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-checkpoint-outside-"));
    const outsideFile = path.join(outside, checkpointName!);
    writeFileSync(outsideFile, readFileSync(checkpointFile));
    rmSync(checkpoints, { recursive: true, force: true });
    symlinkSync(outside, checkpoints, "dir");

    expect(() => readWorkflowCompletedCheckpoint(lease, identity)).toThrow("contains a symlink");
    expect(readFileSync(outsideFile, "utf8")).toContain(checkpoint.childRunId);

    rmSync(checkpoints, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    releaseWorkflowRootLease(lease);
  });

  it("rejects a dangling checkpoint leaf instead of treating it as absent", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, identity.outputDir, "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "checkpoint-dangling" });
    commitWorkflowCompletedCheckpoint(lease, identity);
    const checkpoints = path.join(lease.stateDir, "checkpoints");
    const checkpointName = readdirSync(checkpoints).find((name) => name.endsWith(".json"));
    expect(checkpointName).toBeDefined();
    const checkpointFile = path.join(checkpoints, checkpointName!);
    unlinkSync(checkpointFile);
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-checkpoint-dangling-"));
    symlinkSync(path.join(outside, "missing.json"), checkpointFile);

    expect(() => readWorkflowCompletedCheckpoint(lease, identity)).toThrow("contains a symlink");
    expect(existsSync(path.join(outside, "missing.json"))).toBe(false);

    rmSync(checkpoints, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    releaseWorkflowRootLease(lease);
  });
});

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
    expect(existsSync(path.join(workflowOutputStateDir(root, outputDir), "lease"))).toBe(false);
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
    expect(existsSync(path.join(workflowOutputStateDir(root, outputDir), "lease"))).toBe(false);
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
    expect(existsSync(path.join(workflowOutputStateDir(root, outputDir), "lease"))).toBe(false);
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

  it("fails closed on a symlinked lease directory without touching its external sentinel", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/symlinked-lease", "unused", root);
    const stateDir = workflowOutputStateDir(root, output.identity);
    mkdirSync(stateDir, { recursive: true });
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-lease-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    symlinkSync(outside, path.join(stateDir, "lease"), "dir");

    expect(() => acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "symlinked-lease" })).toThrow(
      "symlink",
    );
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(path.join(stateDir, "lease"), { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("fails closed on lease release after lease-directory replacement", () => {
    const root = project();
    const output = resolveWorkflowOutputDirectory(root, "outputs/replaced-lease", "unused", root);
    const lease = acquireWorkflowRootLease({ projectRoot: root, output, rootRunId: "replaced-lease" });
    const outside = mkdtempSync(path.join(tmpdir(), "workflow-release-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    rmSync(lease.leaseDir, { recursive: true, force: true });
    symlinkSync(outside, lease.leaseDir, "dir");

    expect(() => releaseWorkflowRootLease(lease)).toThrow("symlink");
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(lease.leaseDir, { force: true });
    rmSync(outside, { recursive: true, force: true });
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
    expect(() => commitWorkflowCompletedCheckpoint(current, { ...checkpoint, childRunId: " child" })).toThrow(
      "Invalid workflow run id",
    );
    expect(commitWorkflowCompletedCheckpoint(current, checkpoint)).toMatchObject({ status: "completed" });
    const committed = readWorkflowCompletedCheckpoint(current, checkpoint);
    expect(committed).toMatchObject({ childRunId: checkpoint.childRunId });
    expect(committed).not.toHaveProperty("primaryFile");
    releaseWorkflowRootLease(current);
  });
});
