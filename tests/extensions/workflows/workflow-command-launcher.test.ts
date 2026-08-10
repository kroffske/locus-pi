import { describe, expect, it, vi } from "vitest";
import type {
  RunWorkflowScriptOptions,
  RunWorkflowScriptResult,
} from "../../../extensions/workflows/runtime/workflow-runner.js";
import { createWorkflowCommandLauncher } from "../../../extensions/workflows/workflow-command-launcher.js";
import { createHarness } from "../../test-harness.js";

function completedResult(runId: string): RunWorkflowScriptResult {
  return {
    runId,
    runDir: `/tmp/${runId}`,
    ok: true,
    result: { summary: "done" },
    disposition: { status: "completed" },
    journal: [],
    resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
  };
}

describe("workflow command launcher", () => {
  it("routes ordinary and continuation requests through one runner and observer lifecycle", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    const terminals: string[] = [];
    let nextRun = 0;
    const runScript = vi.fn(async (options: RunWorkflowScriptOptions) => {
      const runId = `launcher-run-${++nextRun}`;
      options.onRunStart?.({ runId, runDir: `/tmp/${runId}` });
      return completedResult(runId);
    });
    const launcher = createWorkflowCommandLauncher({
      pi: harness.pi,
      runScript,
      createObserver(request) {
        return {
          onRunStart({ runId, runDir }) {
            observed.push(`start:${request.scriptRef}:${runId}:${runDir}`);
          },
          onEvent: () => {},
          onResult(result) {
            observed.push(`result:${request.scriptRef}:${result.runId}`);
          },
          onError(error) {
            observed.push(`error:${String(error)}`);
          },
          onFinally() {
            observed.push(`finally:${request.scriptRef}`);
          },
          onRejected() {
            observed.push(`rejected:${request.scriptRef}`);
          },
        };
      },
      onTerminal: (request) => terminals.push(request.scriptRef),
    });
    launcher.startSession(harness.ctx);

    expect(launcher.launch({ ctx: harness.ctx, scriptRef: "ordinary" })).toEqual({ status: "started" });
    await vi.waitFor(() => expect(terminals).toEqual(["ordinary"]));
    expect(
      launcher.launch({
        ctx: harness.ctx,
        scriptRef: "continued",
        input: "answer",
        continuation: { originRunId: "source-run", artifactRefs: [] },
      }),
    ).toEqual({ status: "started" });
    await vi.waitFor(() => expect(terminals).toEqual(["ordinary", "continued"]));

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript.mock.calls[0]?.[0]).toMatchObject({ script: "ordinary" });
    expect(runScript.mock.calls[1]?.[0]).toMatchObject({
      script: "continued",
      input: "answer",
      continuation: { originRunId: "source-run", artifactRefs: [] },
    });
    expect(observed).toEqual([
      "start:ordinary:launcher-run-1:/tmp/launcher-run-1",
      "result:ordinary:launcher-run-1",
      "finally:ordinary",
      "start:continued:launcher-run-2:/tmp/launcher-run-2",
      "result:continued:launcher-run-2",
      "finally:continued",
    ]);
  });
});
