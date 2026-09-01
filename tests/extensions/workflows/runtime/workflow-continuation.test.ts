import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { AgentExecutor } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  assertWorkflowContinuation,
  createWorkflowArtifactStore,
  type WorkflowArtifactRef,
  type WorkflowContinuation,
} from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  readWorkflowRunJournalState,
  workflowJournalFile,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import * as runner from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import workflows from "../../../../extensions/workflows/index.js";
import { createHarness } from "../../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-continuation-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Continuation test agent\nevidence:\n  mode: none\n---\nAnswer.\n",
  );
  const workflowDir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    path.join(workflowDir, "continuation.workflow.mjs"),
    `export default async function runWorkflow(dsl, input) {
  const artifacts = dsl.continuationArtifacts();
  await dsl.agent("inspect continuation", { label: "inspect" });
  return {
    input,
    artifacts: artifacts.map(({ sourceRef, consumedArtifact }) => ({
      sourceRef,
      consumedRef: consumedArtifact.ref,
      text: consumedArtifact.text,
    })),
  };
}
`,
  );
  return root;
}

function runDir(root: string, runId: string): string {
  return ensureWorkflowRunDir(root, runId);
}

function sourceContinuation(
  root: string,
  count = 2,
): { continuation: WorkflowContinuation; refs: WorkflowArtifactRef[] } {
  const runId = "source-run";
  const store = createWorkflowArtifactStore({ projectRoot: root, runId, runDir: runDir(root, runId) });
  const refs = Array.from({ length: count }, (_, index) =>
    store.publishText(index === 0 ? "intent.md" : `artifact-${index + 1}.md`, `source ${index + 1}`, "prepare"),
  );
  writeFileSync(
    workflowResultFile(runDir(root, runId)),
    `${JSON.stringify({
      runId,
      ok: true,
      result: { mode: "prepared", artifactRefs: refs },
      artifactRefs: refs,
      target: { kind: "name", ref: "review", source: "package" },
    })}\n`,
  );
  return { continuation: { originRunId: runId, artifactRefs: refs }, refs };
}

function executor(onRun?: () => void): () => AgentExecutor {
  return () => ({
    async run(request) {
      onRun?.();
      return {
        status: "completed" as const,
        agentName: request.agent?.name ?? "sub-agent",
        reason: "done",
        text: "ok",
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
}

describe("workflow continuation", () => {
  it.each([
    ["originRunId", (value: Record<string, unknown>) => (value.originRunId = 123)],
    ["runId", (value: Record<string, unknown>) => ((value.artifactRefs as Record<string, unknown>[])[0]!.runId = 123)],
    [
      "artifactId",
      (value: Record<string, unknown>) => ((value.artifactRefs as Record<string, unknown>[])[0]!.artifactId = 123),
    ],
    ["name", (value: Record<string, unknown>) => ((value.artifactRefs as Record<string, unknown>[])[0]!.name = 123)],
    [
      "sha256",
      (value: Record<string, unknown>) => ((value.artifactRefs as Record<string, unknown>[])[0]!.sha256 = 123),
    ],
  ])("runtime validator rejects a numeric %s accepted through an untyped caller", (_field, corrupt) => {
    const value: Record<string, unknown> = {
      originRunId: "source-run",
      artifactRefs: [
        {
          runId: "source-run",
          artifactId: "published-0001",
          name: "intent.md",
          sha256: "a".repeat(64),
        },
      ],
    };
    corrupt(value);

    expect(() => assertWorkflowContinuation(value)).toThrow(/Invalid workflow artifact|invalid sha256/u);
  });

  it("consumes exact refs before the first child and exposes readonly source/current pairs", async () => {
    const root = project();
    const { continuation, refs } = sourceContinuation(root);
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "continuation",
      input: "operator answers",
      continuation,
      createExecutor: executor(),
    });

    expect(result.ok).toBe(true);
    // Found by message, not by index: every run now opens with the applied budget
    // line, and pinning this one to position 0 would make an unrelated prelude
    // addition look like a continuation defect.
    const continuationLine = result.journal.find((line) => line.message === "[workflow:continuation]");
    expect(continuationLine).toMatchObject({
      kind: "log",
      source: "runtime",
      message: "[workflow:continuation]",
      continuation: { originRunId: "source-run" },
    });
    const binding = continuationLine?.continuation;
    expect(binding?.artifacts.map((entry) => entry.sourceRef)).toEqual(refs);
    expect(binding?.artifacts.every((entry) => entry.consumedRef.runId === result.runId)).toBe(true);
    expect(result.result).toMatchObject({
      input: "operator answers",
      artifacts: [
        { sourceRef: refs[0], text: "source 1" },
        { sourceRef: refs[1], text: "source 2" },
      ],
    });
    expect(result.journal.findIndex((line) => line.kind === "agent_start")).toBeGreaterThan(0);
    expect(result.continuation).toEqual(binding);
  });

  it.each([
    ["origin mismatch", (value: WorkflowContinuation) => ({ ...value, originRunId: "other-run" })],
    [
      "duplicate",
      (value: WorkflowContinuation) => ({ ...value, artifactRefs: [value.artifactRefs[0]!, value.artifactRefs[0]!] }),
    ],
    [
      "bad digest",
      (value: WorkflowContinuation) => ({
        ...value,
        artifactRefs: [{ ...value.artifactRefs[0]!, sha256: "0".repeat(64) }],
      }),
    ],
    ["empty", (value: WorkflowContinuation) => ({ ...value, artifactRefs: [] })],
  ])("rejects %s before any child runs", async (_name, mutate) => {
    const root = project();
    const { continuation } = sourceContinuation(root);
    let childCalls = 0;
    const harness = createHarness(root);
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "continuation",
      continuation: mutate(continuation),
      createExecutor: executor(() => (childCalls += 1)),
    });

    expect(result.ok).toBe(false);
    expect(childCalls).toBe(0);
    expect(result.journal.every((line) => line.kind !== "agent_start")).toBe(true);
  });

  it("rejects continuation plus resume at the tool and runner boundaries with zero children", async () => {
    const root = project();
    const { continuation } = sourceContinuation(root);
    const harness = createHarness(root);
    workflows(harness.pi);
    const tool = harness.tools.get("workflow")!;
    const runnerSpy = vi.spyOn(runner, "runWorkflowScript");
    const toolResult = await tool.execute(
      "tool-call",
      { name: "continuation", input: "answer", continuation, resumeFromRunId: "source-run" },
      new AbortController().signal,
      () => void 0,
      harness.ctx,
    );
    expect(toolResult.isError).toBe(true);
    expect(runnerSpy).not.toHaveBeenCalled();
    runnerSpy.mockRestore();

    let childCalls = 0;
    const direct = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "continuation",
      continuation,
      resumeFromRunId: "source-run",
      createExecutor: executor(() => (childCalls += 1)),
    });
    expect(direct.ok).toBe(false);
    expect(direct.error).toContain("mutually exclusive");
    expect(childCalls).toBe(0);
  });

  it("keeps the tool continuation schema closed and bounded", () => {
    const root = project();
    const { continuation } = sourceContinuation(root);
    const harness = createHarness(root);
    workflows(harness.pi);
    const schema = harness.tools.get("workflow")!.parameters;

    expect(Value.Check(schema, { name: "continuation", input: "answer", continuation })).toBe(true);
    expect(Value.Check(schema, { name: "continuation", continuation: { ...continuation, extra: true } })).toBe(false);
    expect(
      Value.Check(schema, { name: "continuation", continuation: { ...continuation, originRunId: "../source" } }),
    ).toBe(false);
    expect(
      Value.Check(schema, {
        name: "continuation",
        continuation: {
          ...continuation,
          artifactRefs: [{ ...continuation.artifactRefs[0], name: "nested/intent.md" }],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(schema, {
        name: "continuation",
        continuation: { ...continuation, artifactRefs: [{ ...continuation.artifactRefs[0], extra: true }] },
      }),
    ).toBe(false);
    expect(
      Value.Check(schema, {
        name: "continuation",
        continuation: { ...continuation, artifactRefs: Array(9).fill(continuation.artifactRefs[0]) },
      }),
    ).toBe(false);
  });

  it("rejects non-string nested input before entering the nested workflow callback", async () => {
    let entered = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "nested-input",
      agentRunner: async () => {
        throw new Error("must not run");
      },
    });

    await expect(
      (
        dsl.workflow as (
          callback: (dsl: unknown, input: unknown) => Promise<unknown>,
          input: unknown,
        ) => Promise<unknown>
      )(
        async () => {
          entered += 1;
        },
        { mode: "hidden-protocol" },
      ),
    ).rejects.toThrow(/nested workflow input must be a string/u);
    expect(entered).toBe(0);
  });

  it("journal reader accepts only the exact closed continuation projection", () => {
    const root = project();
    const runId = "journal-run";
    const directory = runDir(root, runId);
    const ref = { runId: "source-run", artifactId: "published-0001", name: "intent.md", sha256: "a".repeat(64) };
    const consumed = { ...ref, runId, artifactId: "input-0001" };
    const base = {
      ts: "2026-07-22T00:00:00.000Z",
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:continuation]",
      continuation: { originRunId: "source-run", artifacts: [{ sourceRef: ref, consumedRef: consumed }] },
    };
    writeFileSync(
      workflowJournalFile(directory),
      [base, { ...base, continuation: { ...base.continuation, extra: true } }]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );

    const state = readWorkflowRunJournalState(root, runId);
    expect(state.lines).toHaveLength(1);
    expect(state.diagnostics[0]?.message).toContain("only originRunId and artifacts");
  });

  it.each([
    ["name", { name: "different.md" }],
    ["sha256", { sha256: "b".repeat(64) }],
  ])("journal reader rejects a consumed ref with changed %s", (_field, changed) => {
    const root = project();
    const runId = "journal-run";
    const directory = runDir(root, runId);
    const sourceRef = {
      runId: "source-run",
      artifactId: "published-0001",
      name: "intent.md",
      sha256: "a".repeat(64),
    };
    const row = {
      ts: "2026-07-22T00:00:00.000Z",
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:continuation]",
      continuation: {
        originRunId: "source-run",
        artifacts: [
          {
            sourceRef,
            consumedRef: { ...sourceRef, runId, artifactId: "input-0001", ...changed },
          },
        ],
      },
    };
    writeFileSync(workflowJournalFile(directory), `${JSON.stringify(row)}\n`);

    const state = readWorkflowRunJournalState(root, runId);
    expect(state.lines).toEqual([]);
    expect(state.diagnostics[0]?.message).toContain("preserve the sourceRef name and sha256");
  });
});
