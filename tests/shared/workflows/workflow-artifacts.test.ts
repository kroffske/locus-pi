import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowArtifactStore,
  readWorkflowArtifactIndex,
  readWorkflowArtifactRecord,
  type WorkflowArtifactIndex,
  type WorkflowArtifactPorts,
} from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import {
  workflowRunArtifactsDir,
  workflowRunRuntimeDir,
} from "../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../extensions/workflows/runtime/workflow-result.js";
import {
  createWorkflowRuntime,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-artifacts-"));
  roots.push(root);
  return root;
}

function runDir(root: string, runId: string): string {
  const dir = path.join(root, ".pi", "locus-pi", "workflows", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("workflow run artifact store", () => {
  it("reads persisted indexes and bytes without creating missing runtime state", () => {
    const root = project();
    const absent = readWorkflowArtifactIndex(root, "absent-run");
    assert.equal(absent.status, "missing");
    assert.equal(existsSync(path.join(root, ".pi")), false);

    const id = "reader-run";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    const ref = store.publishText("reader.md", "reader bytes");
    assert.match(store.list()[0]?.relativePath ?? "", /published-0001-reader\.md$/u);
    const index = readWorkflowArtifactIndex(root, id);
    const record = readWorkflowArtifactRecord(root, id, ref.artifactId);

    assert.equal(index.status, "ready");
    assert.equal(record.status, "ready");
    if (record.status === "ready") assert.equal(record.bytes.toString("utf8"), "reader bytes");
    assert.equal(readWorkflowArtifactRecord(root, id, "missing-id").status, "missing");
    assert.equal(readWorkflowArtifactIndex(root, "../escape").status, "invalid");
  });

  it("persists exactly one explicitly primary publication", () => {
    const root = project();
    const id = "primary-run";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });

    const ref = store.publishText("plan.md", "accepted plan", "finalize", "primary");

    assert.equal(ref.name, "plan.md");
    assert.equal(store.list()[0]?.kind, "primary");
    assert.throws(
      () => store.publishText("other.md", "other", "finalize", "primary"),
      /already contains a primary output/u,
    );
  });

  it("publishes and consumes only a complete verified prior-run text reference", () => {
    const root = project();
    const sourceRunId = "source-run";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const sourceRef = source.publishText("plan.md", "exact plan", "prepare");
    const terminalResult = {
      mode: "prepared",
      intentRef: sourceRef,
      questionsRef: { ...sourceRef, artifactId: "published-0002", name: "questions.md" },
    };
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        ok: true,
        result: terminalResult,
        artifactRefs: [sourceRef],
        target: { kind: "name", ref: "review", source: "package", path: "/private/ignored.workflow.mjs" },
      })}\n`,
    );

    const currentRunId = "current-run";
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: currentRunId,
      runDir: runDir(root, currentRunId),
    });
    const consumed = current.consumeText(sourceRef, "execute");

    assert.equal(consumed.text, "exact plan");
    assert.equal(consumed.ref.runId, currentRunId);
    assert.deepEqual(consumed.source, {
      runId: sourceRunId,
      target: { kind: "name", ref: "review", source: "package" },
      artifact: { kind: "published", stage: "prepare" },
      terminal: { result: terminalResult, artifactRefs: [sourceRef] },
    });
    assert.deepEqual(current.list().find((entry) => entry.artifactId === consumed.ref.artifactId)?.source, sourceRef);
    assert.throws(
      () => current.consumeText({ ...sourceRef, sha256: "0".repeat(64) }),
      /does not match its source index/u,
    );
    assert.throws(() => current.consumeText(consumed.ref), /self-reference/u);
    assert.throws(() => current.consumeText({ ...sourceRef, runId: "../escape" }), /Invalid workflow artifact runId/u);
  });

  it("refuses an indexed source artifact omitted from the terminal handoff projection", () => {
    const root = project();
    const sourceRunId = "projected-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: sourceRunId,
      runDir: runDir(root, sourceRunId),
    });
    const projectedRef = source.publishText("projected.md", "projected");
    const omittedRef = source.publishText("omitted.md", "omitted");
    writeFileSync(
      workflowResultFile(runDir(root, sourceRunId)),
      `${JSON.stringify({
        ok: true,
        result: "projected",
        artifactRefs: [projectedRef],
        artifactRefsOmitted: 1,
        target: { kind: "name", ref: "review", source: "package" },
      })}\n`,
    );
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "projection-consumer",
      runDir: runDir(root, "projection-consumer"),
    });

    assert.throws(() => current.consumeText(omittedRef), /not present in the source run terminal projection/u);
    assert.equal(current.consumeText(projectedRef).text, "projected");
  });

  it("refuses malformed optional metadata and unknown persisted fields", () => {
    const corruptions: Array<[string, (record: Record<string, unknown>) => void]> = [
      ["callId type", (record) => (record.callId = 42)],
      ["callId value", (record) => (record.callId = "../escape")],
      ["stage", (record) => (record.stage = { name: "prepare" })],
      ["childSessionId", (record) => (record.childSessionId = null)],
      ["source", (record) => (record.source = { runId: "source" })],
      ["replaySourceRunId", (record) => (record.replaySourceRunId = [])],
      ["unknown", (record) => (record.untrusted = true)],
    ];

    for (const [name, corrupt] of corruptions) {
      const root = project();
      const id = `invalid-${name.replaceAll(/[^a-z]+/gu, "-")}`;
      const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
      store.publishText("record.md", "bytes");
      const indexPath = path.join(store.artifactsDir, "index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as { artifacts: Array<Record<string, unknown>> };
      corrupt(index.artifacts[0]!);
      writeFileSync(indexPath, `${JSON.stringify(index)}\n`);

      const read = readWorkflowArtifactIndex(root, id);
      assert.equal(read.status, "invalid", name);
    }

    const root = project();
    const id = "invalid-index-envelope";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: runDir(root, id) });
    const indexPath = path.join(store.artifactsDir, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    index.untrusted = true;
    writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
    assert.equal(readWorkflowArtifactIndex(root, id).status, "invalid");
  });

  it("keeps missing source indexes side-effect free and rejects missing source target identity", () => {
    const root = project();
    const currentId = "lineage-reader";
    const current = createWorkflowArtifactStore({
      projectRoot: root,
      runId: currentId,
      runDir: runDir(root, currentId),
    });
    const missingIndexRun = "legacy-source";
    const legacyDir = runDir(root, missingIndexRun);
    mkdirSync(workflowRunRuntimeDir(legacyDir), { recursive: true });
    writeFileSync(
      workflowResultFile(legacyDir),
      `${JSON.stringify({ ok: true, target: { kind: "name", ref: "review", source: "package" } })}\n`,
    );
    const legacyRef = {
      runId: missingIndexRun,
      artifactId: "published-0001",
      name: "plan.md",
      sha256: "a".repeat(64),
    };

    assert.throws(() => current.consumeText(legacyRef), /index is missing/u);
    assert.equal(existsSync(path.join(workflowRunArtifactsDir(legacyDir), "index.json")), false);

    const noTargetRun = "missing-target-source";
    const source = createWorkflowArtifactStore({
      projectRoot: root,
      runId: noTargetRun,
      runDir: runDir(root, noTargetRun),
    });
    const ref = source.publishText("plan.md", "bytes");
    writeFileSync(workflowResultFile(runDir(root, noTargetRun)), '{"ok":true}\n');
    assert.throws(() => current.consumeText(ref), /not usable/u);
    assert.equal(
      current.list().some((record) => record.kind === "input"),
      false,
    );
  });

  it("removes orphan bytes after index persistence failure so retry can succeed", () => {
    const root = project();
    const id = "recover-index-failure";
    let sabotageIndex = false;
    let indexPath = "";
    const store = createWorkflowArtifactStore({
      projectRoot: root,
      runId: id,
      runDir: runDir(root, id),
      now() {
        if (sabotageIndex) writeFileSync(indexPath, "externally changed\n");
        return "2026-07-22T00:00:00.000Z";
      },
    });
    indexPath = path.join(store.artifactsDir, "index.json");
    const originalIndex = readFileSync(indexPath);
    const destination = path.join(store.artifactsDir, "published", "published-0001-retry.md");

    sabotageIndex = true;
    assert.throws(() => store.publishText("retry.md", "first attempt"), /index changed outside its owner/u);
    assert.equal(existsSync(destination), false);

    sabotageIndex = false;
    writeFileSync(indexPath, originalIndex);
    const ref = store.publishText("retry.md", "second attempt");
    assert.equal(store.read(ref).toString("utf8"), "second attempt");
  });

  it("refuses tampered bytes, corrupt indexes, and symlink destinations", () => {
    const root = project();
    const firstId = "tamper-run";
    const firstDir = runDir(root, firstId);
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: firstId, runDir: firstDir });
    const ref = store.publishText("report.md", "original");
    const record = store.list().find((entry) => entry.artifactId === ref.artifactId)!;
    writeFileSync(path.join(store.artifactsDir, record.relativePath), "changed");
    assert.throws(() => store.read(ref), /digest mismatch/u);
    assert.equal(readWorkflowArtifactRecord(root, firstId, ref.artifactId).status, "tampered");

    writeFileSync(path.join(store.artifactsDir, "index.json"), "{broken");
    assert.throws(
      () => createWorkflowArtifactStore({ projectRoot: root, runId: firstId, runDir: firstDir }),
      /index is corrupt/u,
    );

    const linkId = "link-run";
    const linked = createWorkflowArtifactStore({ projectRoot: root, runId: linkId, runDir: runDir(root, linkId) });
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(linked.artifactsDir, "published"));
    assert.throws(() => linked.publishText("escape.md", "no"), /unsafe/u);
  });

  it("rejects symlinked canonical-root ancestors before external artifact reads or writes", () => {
    for (const linkedAncestor of [".pi", "locus-pi"] as const) {
      const root = project();
      const external = project();
      const id = `ancestor-${linkedAncestor.replace(".", "")}`;
      const externalPi = path.join(external, "external-pi");
      const externalLocusPi = path.join(external, "external-locus-pi");
      const externalRunDir =
        linkedAncestor === ".pi"
          ? path.join(externalPi, "locus-pi", "workflows", id)
          : path.join(externalLocusPi, "workflows", id);
      mkdirSync(externalRunDir, { recursive: true });

      if (linkedAncestor === ".pi") {
        symlinkSync(externalPi, path.join(root, ".pi"));
      } else {
        mkdirSync(path.join(root, ".pi"));
        symlinkSync(externalLocusPi, path.join(root, ".pi", "locus-pi"));
      }

      const externalArtifacts = workflowRunArtifactsDir(externalRunDir);
      assert.throws(
        () =>
          createWorkflowArtifactStore({
            projectRoot: root,
            runId: id,
            runDir: path.join(root, ".pi", "locus-pi", "workflows", id),
          }),
        /directory is unsafe/u,
      );
      assert.equal(existsSync(externalArtifacts), false, `${linkedAncestor}: no external artifact write`);

      mkdirSync(externalArtifacts, { recursive: true });
      writeFileSync(path.join(externalArtifacts, "index.json"), "{externally controlled");
      const indexRead = readWorkflowArtifactIndex(root, id);
      assert.equal(indexRead.status, "invalid", `${linkedAncestor}: external index rejected`);
      if (indexRead.status === "invalid") {
        assert.match(indexRead.message, /directory is unsafe/u, `${linkedAncestor}: rejected before external parse`);
      }
      assert.equal(readWorkflowArtifactRecord(root, id, "published-0001").status, "invalid");
    }
  });

  it("allocates distinct call identities before parallel scheduling and persists text before failure propagation", async () => {
    const calls: string[] = [];
    const sequence: string[] = [];
    const ports: WorkflowArtifactPorts = {
      recordAgentEvidence(input) {
        calls.push(input.callId);
        sequence.push(`persist:${input.text}`);
        return {};
      },
      publishText() {
        throw new Error("unused");
      },
      consumeText() {
        throw new Error("unused");
      },
    };
    const runtime = createWorkflowRuntime({
      runId: "parallel-identities",
      artifactPorts: ports,
      onEvent(line) {
        if (line.kind === "agent_end") sequence.push(`end:${line.status}`);
      },
      agentRunner: async (request: WorkflowAgentRequest) => ({
        ok: request.prompt !== "bad",
        status: request.prompt === "bad" ? "failed" : "completed",
        summary: request.prompt,
        text: request.prompt === "bad" ? "partial answer" : request.prompt,
        diagnostics: [],
        agent: request.agent,
      }),
    });

    await runtime.dsl.parallel([
      () => runtime.dsl.agent("one", { label: "same" }),
      () => runtime.dsl.agent("two", { label: "same" }),
    ]);
    await assert.rejects(runtime.dsl.agent("bad"), WorkflowAgentExecutionError);

    assert.deepEqual(calls, ["call-0001", "call-0002", "call-0003"]);
    assert.ok(sequence.indexOf("persist:partial answer") < sequence.indexOf("end:failed"));
  });

  it("fails a successful child when automatic answer persistence fails", async () => {
    const runtime = createWorkflowRuntime({
      runId: "write-failure",
      artifactPorts: {
        recordAgentEvidence() {
          throw new Error("injected index write failure");
        },
        publishText() {
          throw new Error("unused");
        },
        consumeText() {
          throw new Error("unused");
        },
      },
      agentRunner: async (request) => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: "must persist",
        diagnostics: [],
        agent: request.agent,
      }),
    });

    await assert.rejects(runtime.dsl.agent("work"), /injected index write failure/u);
    assert.equal(
      runtime.getJournal().some((line) => line.kind === "agent_end"),
      false,
    );
    assert.equal(
      runtime.getJournal().some((line) => line.kind === "error"),
      true,
    );
  });

  it("wires exact answers, child transcripts, and result envelopes below one run root", async () => {
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "evidence.workflow.mjs"),
      'export default async function runWorkflow(dsl) { return { ok: true, answer: await dsl.agent("answer", { artifact: "review.md" }) }; }\n',
    );
    const harness = createHarness(root, { sessionId: "artifact-parent" });
    const createExecutor = (options: { reportsDir?: string }): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        assert.ok(options.reportsDir !== undefined);
        mkdirSync(options.reportsDir, { recursive: true });
        const childId = "child-evidence";
        const tracePath = path.join(options.reportsDir, "child.jsonl");
        writeFileSync(tracePath, `${JSON.stringify({ type: "session", id: childId })}\n`);
        return {
          status: "completed",
          agentName: request.agent.name,
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
          childSession: { id: childId, createdAt: "now", metadata: {} },
          childTrace: { path: tracePath, format: "pi-session-jsonl", childSessionId: childId },
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "evidence",
      createExecutor,
    });

    assert.equal(result.ok, true, result.error);
    const index = JSON.parse(
      readFileSync(path.join(workflowRunArtifactsDir(result.runDir), "index.json"), "utf8"),
    ) as WorkflowArtifactIndex;
    assert.deepEqual(index.artifacts.map((entry) => entry.kind).sort(), ["answer", "result", "transcript"]);
    assert.ok(index.artifacts.every((entry) => !path.isAbsolute(entry.relativePath)));
    assert.equal(index.artifacts.find((entry) => entry.kind === "answer")?.name, "review.md");
    assert.ok(
      index.artifacts.every((entry) =>
        path
          .resolve(workflowRunArtifactsDir(result.runDir), entry.relativePath)
          .startsWith(workflowRunArtifactsDir(result.runDir)),
      ),
    );
  });

  it("persists a replayed answer with provenance and fabricates no transcript", async () => {
    const root = project();
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
    );
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "replay.workflow.mjs"),
      'export default async function runWorkflow(dsl) { return { ok: true, answer: await dsl.agent("same") }; }\n',
    );
    const harness = createHarness(root, { sessionId: "replay-parent" });
    let executions = 0;
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        executions += 1;
        return {
          status: "completed",
          agentName: request.agent.name,
          reason: "recorded answer",
          text: "recorded answer",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });
    const first = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "replay",
      createExecutor,
    });
    const replay = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "replay",
      createExecutor,
      resumeFromRunId: first.runId,
    });

    assert.equal(first.ok, true, first.error);
    assert.equal(replay.ok, true, replay.error);
    assert.equal(executions, 1);
    const index = JSON.parse(
      readFileSync(path.join(workflowRunArtifactsDir(replay.runDir), "index.json"), "utf8"),
    ) as WorkflowArtifactIndex;
    assert.deepEqual(
      index.artifacts.map((entry) => entry.kind),
      ["answer"],
    );
    assert.equal(index.artifacts[0]?.provenance, "replay");
    assert.equal(index.artifacts[0]?.replaySourceRunId, first.runId);
  });
});
