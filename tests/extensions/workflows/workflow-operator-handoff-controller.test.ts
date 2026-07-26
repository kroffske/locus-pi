import { describe, expect, it, vi } from "vitest";
import {
  WorkflowOperatorHandoffController,
  type ActionableWorkflowHandoff,
  type WorkflowHandoffControllerPorts,
} from "../../../extensions/workflows/operator-handoff-controller.js";
import { requestInlineOperatorInteraction } from "../../../extensions/_shared/operator-interaction.js";
import type { CustomUiComponent, CustomUiFactory } from "../../../extensions/_shared/pi-api.js";
import { createHarness } from "../../test-harness.js";

function handoff(runId: string, overrides: Partial<ActionableWorkflowHandoff> = {}): ActionableWorkflowHandoff {
  return {
    runId,
    title: `Workflow ${runId}`,
    questions: [
      {
        kind: "select",
        id: "scope",
        prompt: "Choose scope",
        options: [{ label: "Current changes" }, { label: "Last commit" }],
        recommended: "Current changes",
        allowCustom: true,
      },
    ],
    value: {
      version: "locus.workflow.operator-handoff.v1",
      handoffId: `handoff-${runId}`,
      originRunId: runId,
      title: `Workflow ${runId}`,
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
          recommended: "Current changes",
          allowCustom: true,
        },
      ],
      continuationArtifactRefs: [],
      target: { kind: "name", ref: "review", source: "package" },
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        scriptSha256: "0".repeat(64),
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
      },
    },
    ...overrides,
  };
}

function controller(
  listed: ActionableWorkflowHandoff[],
  launch = vi.fn(async (_item: ActionableWorkflowHandoff, _answer: string, _ctx: unknown) => ({
    status: "started" as const,
  })),
): { controller: WorkflowOperatorHandoffController; launch: typeof launch } {
  const byId = new Map(listed.map((item) => [item.runId, item]));
  const ports: WorkflowHandoffControllerPorts = {
    scan: () => listed.map((handoff) => ({ status: "actionable", handoff })),
    read: (_projectRoot, runId) => byId.get(runId),
    launch,
  };
  return { controller: new WorkflowOperatorHandoffController(ports), launch };
}

describe("workflow operator handoff controller", () => {
  it("opens the oldest actionable handoff first and renders FIFO progress without a run picker", async () => {
    const newer = handoff("20260725-130000-new");
    const older = handoff("20260725-120000-old");
    const { controller: queue, launch } = controller([newer, older]);
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: older.runId,
    });
    expect(launch).toHaveBeenCalledWith(older, "Current changes", harness.ctx);
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Question 1 of 2");
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Choose scope");
    expect(harness.customRenderFrames[0]?.join("\n")).not.toContain(newer.runId);
    expect(harness.customOptions).toEqual([{ overlay: false }]);
  });

  it("uses persisted chronology for same-second runs instead of sorting random suffixes", async () => {
    const newer = handoff("20260725-120000-0001");
    const older = handoff("20260725-120000-ffff");
    const { controller: queue, launch } = controller([newer, older]);
    const harness = createHarness();
    harness.customInputQueue.push("\r");

    expect(queue.eligibleRunIds("/project")).toEqual([older.runId, newer.runId]);
    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: older.runId,
    });
    expect(launch).toHaveBeenCalledWith(older, "Current changes", harness.ctx);
  });

  it("treats Escape as a session snooze and lets explicit recovery reopen the same question", async () => {
    const item = handoff("20260725-120000-pending");
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("\x1b");

    await expect(queue.pump(harness.ctx)).resolves.toEqual({
      status: "cancelled",
      runId: item.runId,
    });
    await expect(queue.pump(harness.ctx)).resolves.toEqual({ status: "snoozed" });
    expect(launch).not.toHaveBeenCalled();

    harness.customInputQueue.push("\x1b[B", "\x1b[B", "\r", "custom scope", "\r");
    await expect(queue.pump(harness.ctx, { explicit: true })).resolves.toMatchObject({
      status: "started",
      sourceRunId: item.runId,
    });
    expect(launch).toHaveBeenCalledWith(item, "custom scope", harness.ctx);
  });

  it("collects multiple questions in one component at a time and renders one deterministic input", async () => {
    const item = handoff("20260725-120000-multi", {
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose scope",
          options: [{ label: "Current changes" }],
        },
        {
          kind: "text",
          id: "note",
          prompt: "Add a note",
        },
      ],
    });
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("\r", "Keep generated files excluded.", "\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });
    expect(launch.mock.calls[0]?.[1]).toBe(
      "1. Choose scope\n   id: scope\n   answer: Current changes\n2. Add a note\n   id: note\n   answer: Keep generated files excluded.",
    );
    expect(harness.customComponents).toHaveLength(2);
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("Prompt 1 of 2");
    expect(harness.customRenderFrames.at(-1)?.join("\n")).toContain("Prompt 2 of 2");
  });

  it("names the blocked run and the tool that blocked it inside the question block", async () => {
    const item = handoff("20260725-120000-multi", {
      questions: [{ kind: "text", id: "note", prompt: "Add a note" }],
    });
    const { controller: queue } = controller([item]);
    const harness = createHarness();
    harness.customInputQueue.push("Keep generated files excluded.", "\r");

    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({ status: "started" });
    const frame = harness.customRenderFrames[0]?.join("\n") ?? "";
    // Provenance survives a narrow terminal because it is a body line, not a
    // badge, and the progress badge is still there beside it.
    expect(frame).toContain("run #ulti · awaitOperator");
    expect(frame).toContain("Question 1 of 1");
  });

  it("validates explicit noninteractive answers without mounting UI", async () => {
    const item = handoff("20260725-120000-explicit", {
      questions: [
        {
          kind: "select",
          id: "scope",
          prompt: "Choose scope",
          options: [{ label: "Current changes" }, { label: "Last commit" }],
        },
      ],
    });
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness(process.cwd(), { mode: "json" });

    await expect(
      queue.pump(harness.ctx, { explicit: true, runId: item.runId, answer: "Unknown scope" }),
    ).resolves.toMatchObject({
      status: "invalid",
      message: expect.stringContaining("exactly match"),
    });
    await expect(
      queue.pump(harness.ctx, { explicit: true, runId: item.runId, answer: "Last commit" }),
    ).resolves.toMatchObject({ status: "started" });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(harness.customComponents).toEqual([]);
  });

  it("requires explicit input in one-way modes and drops stale-session mounts", async () => {
    const item = handoff("20260725-120000-mode");
    const { controller: queue, launch } = controller([item]);
    const jsonHarness = createHarness(process.cwd(), { mode: "json" });

    await expect(queue.pump(jsonHarness.ctx, { explicit: true, runId: item.runId })).resolves.toEqual({
      status: "unavailable",
      runId: item.runId,
    });
    const tuiHarness = createHarness();
    await expect(queue.pump(tuiHarness.ctx, { explicit: true, isCurrent: () => false })).resolves.toEqual({
      status: "stale",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not mount or launch after a held interaction slot reaches the front while Pi is busy", async () => {
    const item = handoff("20260725-120000-held");
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const held = requestInlineOperatorInteraction(harness.ctx, () => inertComponent());
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const pending = queue.pump(harness.ctx);
    harness.setStreaming(true);
    completions[0]!("released");

    await expect(held).resolves.toBe("released");
    await expect(pending).resolves.toEqual({ status: "busy" });
    expect(harness.ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it("keeps a handoff pending when Pi becomes busy after the answer and launches it on retry", async () => {
    const item = handoff("20260725-120000-answer-race");
    const { controller: queue, launch } = controller([item]);
    const harness = createHarness();
    const custom = harness.ctx.ui.custom!;
    harness.ctx.ui.custom = (async (...args: Parameters<typeof custom>) => {
      const result = await custom.apply(harness.ctx.ui, args);
      harness.setStreaming(true);
      return result;
    }) as typeof custom;
    harness.customInputQueue.push("\r");

    await expect(queue.pump(harness.ctx)).resolves.toEqual({ status: "busy" });
    expect(launch).not.toHaveBeenCalled();

    harness.setStreaming(false);
    harness.ctx.ui.custom = custom;
    harness.customInputQueue.push("\r");
    await expect(queue.pump(harness.ctx)).resolves.toMatchObject({
      status: "started",
      sourceRunId: item.runId,
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("translates unexpected pump failures to invalid instead of rejecting", async () => {
    const item = handoff("20260725-120000-rejection");
    const ports: WorkflowHandoffControllerPorts = {
      scan: () => {
        throw new Error("durable scan exploded");
      },
      read: () => item,
      launch: vi.fn(),
    };
    const queue = new WorkflowOperatorHandoffController(ports);
    const harness = createHarness();

    await expect(queue.pump(harness.ctx)).resolves.toEqual({
      status: "invalid",
      message: "Workflow handoff pump failed: durable scan exploded",
    });
  });
});

function inertComponent(): CustomUiComponent {
  return {
    render: () => ["held"],
    invalidate() {},
  };
}
