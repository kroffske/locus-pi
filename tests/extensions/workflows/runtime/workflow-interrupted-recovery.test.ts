/** Admission integration needs installed dependencies and native source validation. No real provider calls. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import { createHarness } from "../../../test-harness.js";
import { runWorkflowScript } from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { workflowLaunchBindingFile } from "../../../../extensions/workflows/runtime/workflow-launch-binding.js";
it("new ordinary roots preserve launch-binding projections for ordinary resume and opt-in interrupted recovery", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "locus-interrupted-admission-"));
  const previousRolesHome = process.env.PI_MODEL_ROLES_HOME;
  process.env.PI_MODEL_ROLES_HOME = path.join(root, ".pi-user");
  try {
    const h = createHarness(root);
    let calls = 0;
    mkdirSync(path.join(root, ".locus-pi/workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".locus-pi/workflows/serial.workflow.mjs"),
      'export const meta = { name: "serial", profile: "standard" }; export default async function run(dsl, input) { return await dsl.agent(input, ' +
        '{ label: "worker" }); }\n',
    );
    const options = {
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      name: "serial",
      input: "fixed goal",
      createExecutor: () => ({
        async run() {
          calls += 1;
          return {
            status: "completed" as const,
            executionMode: "bare" as const,
            reason: "confirmed",
            text: "confirmed",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    };
    const initial = await runWorkflowScript(options);
    assert.equal(initial.ok, true, initial.error);
    assert.equal(calls, 1);
    const resultPath = workflowResultFile(initial.runDir);
    const terminal = JSON.parse(readFileSync(resultPath, "utf8"));
    const binding = JSON.parse(readFileSync(workflowLaunchBindingFile(initial.runDir), "utf8"));
    assert.equal(terminal.semanticInputSha256, binding.semanticInput.sha256);
    const resumed = await runWorkflowScript({ ...options, resumeFromRunId: initial.runId });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(calls, 1);
    // Missing terminal publication is simulated here; a separate subprocess contract exercises real SIGKILL.
    unlinkSync(resultPath);
    const recovered = await runWorkflowScript({ ...options, resumeFromRunId: initial.runId, recoverInterrupted: true });
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(calls, 1);
    assert.equal(recovered.replay?.replayedCalls, 1);
    const changed = await runWorkflowScript({
      ...options,
      input: "different goal",
      resumeFromRunId: initial.runId,
      recoverInterrupted: true,
    });
    assert.equal(changed.ok, false);
    assert.equal(calls, 1);
    assert.match(changed.error ?? "", /identical target, source, input/u);
    writeFileSync(resultPath, "{damaged");
    const damaged = await runWorkflowScript({ ...options, resumeFromRunId: initial.runId, recoverInterrupted: true });
    assert.equal(damaged.ok, false);
    assert.equal(calls, 1);
    // A corrupt terminal file is not an absent one: the ordinary resume preflight
    // refuses the unreadable source run before recovery admission is consulted.
    assert.match(damaged.error ?? "", /not found or unusable|absent result\.json/u);
  } finally {
    if (previousRolesHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = previousRolesHome;
    rmSync(root, { recursive: true, force: true });
  }
});
