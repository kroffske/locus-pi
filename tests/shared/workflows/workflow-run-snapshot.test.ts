import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowRunScriptSnapshot } from "../../../extensions/workflows/runtime/workflow-journal.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persisted workflow run source snapshot", () => {
  it("reads only the exact hash-named regular file inside the exact run directory", () => {
    const fixture = writeSnapshotRun("20260713-010101-ready", "export default () => 'ready';\n");

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toEqual({
      kind: "ready",
      runId: fixture.runId,
      target: { kind: "name", ref: "alpha", source: "project" },
      path: fixture.snapshotPath,
      sha256: fixture.sha256,
      identityCoverage: "self-contained-static",
      source: fixture.source,
    });
  });

  it.each(["../escape", "/tmp/escape", "nested/run"])("rejects non-simple run id %j", (runId) => {
    const root = temporaryRoot();
    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({ kind: "invalid", runId });
  });

  it("reports legacy results without snapshot identity and never reads current source", () => {
    const root = temporaryRoot();
    const runId = "20260713-010102-legacy";
    const runDir = workflowRunDirectory(root, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "result.json"),
      JSON.stringify({
        target: { kind: "name", ref: "alpha", source: "project" },
      }),
    );
    writeFileSync(path.join(root, "current-decoy.workflow.mjs"), "must not be read");

    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({
      kind: "legacy",
      target: { ref: "alpha" },
    });
  });

  it("reports malformed persisted snapshot identity as invalid rather than legacy", () => {
    const fixture = writeSnapshotRun("20260713-010102-invalid-identity", "invalid identity\n");
    writeFileSync(
      path.join(fixture.runDir, "result.json"),
      JSON.stringify({
        target: { kind: "name", ref: "alpha", source: "project" },
        scriptIdentity: { snapshotPath: fixture.snapshotPath, scriptSha256: "wrong" },
      }),
    );

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("reports a missing expected snapshot", () => {
    const fixture = writeSnapshotRun("20260713-010103-missing", "missing\n");
    rmSync(fixture.snapshotPath);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
      kind: "missing",
      path: fixture.snapshotPath,
      sha256: fixture.sha256,
    });
  });

  it("rejects a file symlink even when its target bytes and basename hash match", () => {
    const fixture = writeSnapshotRun("20260713-010104-file-link", "file symlink\n");
    const external = path.join(fixture.root, "external.workflow.mjs");
    writeFileSync(external, fixture.source);
    rmSync(fixture.snapshotPath);
    symlinkSync(external, fixture.snapshotPath);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a symlinked ancestor below the project root", () => {
    const root = temporaryRoot();
    const external = temporaryRoot();
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    symlinkSync(external, path.join(root, ".pi", "locus-pi"));
    const runId = "20260713-010105-ancestor-link";
    const source = "ancestor symlink\n";
    const sha256 = digest(source);
    const externalRunDir = path.join(external, "workflows", runId);
    mkdirSync(externalRunDir, { recursive: true });
    const snapshotPath = path.join(root, ".pi", "locus-pi", "workflows", runId, `script-${sha256}.workflow.mjs`);
    writeFileSync(path.join(externalRunDir, path.basename(snapshotPath)), source);
    writeResult(externalRunDir, snapshotPath, sha256);

    expect(readWorkflowRunScriptSnapshot(root, runId)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a wrong basename or path even when the bytes hash correctly", () => {
    const fixture = writeSnapshotRun("20260713-010106-wrong-name", "wrong name\n");
    const wrongPath = path.join(path.dirname(fixture.snapshotPath), "snapshot.workflow.mjs");
    rmSync(fixture.snapshotPath);
    writeFileSync(wrongPath, fixture.source);
    writeResult(path.dirname(wrongPath), wrongPath, fixture.sha256);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });

  it("reports changed bytes as tampered", () => {
    const fixture = writeSnapshotRun("20260713-010107-tampered", "original\n");
    writeFileSync(fixture.snapshotPath, "changed\n");

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({
      kind: "tampered",
      sha256: fixture.sha256,
    });
  });

  it("rejects a directory at the expected snapshot path", () => {
    const fixture = writeSnapshotRun("20260713-010108-directory", "directory\n");
    rmSync(fixture.snapshotPath);
    mkdirSync(fixture.snapshotPath);

    expect(readWorkflowRunScriptSnapshot(fixture.root, fixture.runId)).toMatchObject({ kind: "invalid" });
  });
});

function writeSnapshotRun(runId: string, source: string) {
  const root = temporaryRoot();
  const runDir = workflowRunDirectory(root, runId);
  const sha256 = digest(source);
  const snapshotPath = path.join(runDir, `script-${sha256}.workflow.mjs`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(snapshotPath, source);
  writeResult(runDir, snapshotPath, sha256);
  return { root, runId, runDir, source, sha256, snapshotPath };
}

function writeResult(runDir: string, snapshotPath: string, sha256: string): void {
  writeFileSync(
    path.join(runDir, "result.json"),
    JSON.stringify({
      ok: true,
      target: { kind: "name", ref: "alpha", source: "project" },
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        sourcePath: path.join(path.dirname(runDir), "alpha.workflow.mjs"),
        snapshotPath,
        scriptSha256: sha256,
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        builtinImports: [],
        unboundDependencies: [],
      },
    }),
  );
}

function workflowRunDirectory(root: string, runId: string): string {
  return path.join(root, ".pi", "locus-pi", "workflows", runId);
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "workflow-run-snapshot-"));
  roots.push(root);
  return root;
}

function digest(source: string): string {
  return createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex");
}
