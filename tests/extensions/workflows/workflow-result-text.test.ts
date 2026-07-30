import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkflowRunResultText,
  resolveWorkflowRunId,
  workflowRunDir,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import { writeWorkflowResultText } from "../../../extensions/workflows/runtime/workflow-result.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-result-text-"));
  roots.push(root);
  return root;
}

const REVIEW_TEXT = [
  "# Code Review",
  "",
  "## Verdict",
  "",
  "Needs changes",
  "",
  ...Array.from({ length: 60 }, (_value, index) => `Finding line ${index + 1} of the full review body.`),
  "",
  "## Last line of the review",
].join("\n");

/**
 * One finished run on disk. `resultText: false` reproduces a run recorded before
 * result.md existed, which is the only copy those runs ever had.
 */
function writeFinishedRun(
  root: string,
  runId: string,
  result: unknown,
  options: { resultText?: boolean } = {},
): string {
  const runDir = workflowRunDir(root, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "journal.ndjson"),
    `${JSON.stringify({ ts: "2026-07-26T21:27:52.000Z", runId, kind: "phase", phase: "review" })}\n`,
    "utf8",
  );
  writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify({ runId, ok: true, result }, null, 2)}\n`, "utf8");
  if (options.resultText !== false) writeWorkflowResultText(runDir, result);
  return runDir;
}

describe("workflow result text persistence", () => {
  it("writes a prose result verbatim and leaves a structured result to result.json", () => {
    const root = makeRoot();
    const runDir = writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);

    const written = readFileSync(path.join(runDir, "result.md"), "utf8");
    expect(written).toContain("# Code Review");
    expect(written).toContain("## Last line of the review");
    expect(written.trimEnd()).toBe(REVIEW_TEXT.trimEnd());

    const structuredDir = writeFinishedRun(root, "20260726-212752-aa11", { verdict: "pass", findings: [] });
    expect(writeWorkflowResultText(structuredDir, { verdict: "pass" })).toBeUndefined();
  });

  it("reads the whole text back, including for a run finished before result.md existed", () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    writeFinishedRun(root, "20260725-101010-7f3a", REVIEW_TEXT, { resultText: false });

    const fresh = readWorkflowRunResultText(root, "20260726-212752-98cc");
    expect(fresh.status).toBe("ready");
    if (fresh.status !== "ready") return;
    expect(fresh.path.endsWith("result.md")).toBe(true);
    expect(fresh.text).toContain("## Last line of the review");

    const legacy = readWorkflowRunResultText(root, "20260725-101010-7f3a");
    expect(legacy.status).toBe("ready");
    if (legacy.status !== "ready") return;
    expect(legacy.path.endsWith("result.json")).toBe(true);
    expect(legacy.text).toContain("## Last line of the review");
    expect(legacy.text).not.toContain("\\n");
  });

  it("resolves the run id an operator actually has: the printed short suffix, or last", () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260725-101010-7f3a", "older run");
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);

    expect(resolveWorkflowRunId(root, "20260726-212752-98cc")).toEqual({
      status: "resolved",
      runId: "20260726-212752-98cc",
    });
    expect(resolveWorkflowRunId(root, "98cc")).toEqual({ status: "resolved", runId: "20260726-212752-98cc" });
    expect(resolveWorkflowRunId(root, "#98cc")).toEqual({ status: "resolved", runId: "20260726-212752-98cc" });
    expect(resolveWorkflowRunId(root, "last")).toEqual({ status: "resolved", runId: "20260726-212752-98cc" });
    expect(resolveWorkflowRunId(root, "nope")).toEqual({ status: "not-found" });
  });

  it("refuses an ambiguous short id instead of opening the wrong run", () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260725-101010-98cc", "older run");
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);

    const resolution = resolveWorkflowRunId(root, "98cc");
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "ambiguous") return;
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.matched).toBe(2);
  });

  it("reports the real number of matching runs even when the listed candidates are capped", async () => {
    const root = makeRoot();
    for (const index of [1, 2, 3, 4, 5, 6]) writeFinishedRun(root, `2026072${index}-101010-98cc`, `run ${index}`);

    const resolution = resolveWorkflowRunId(root, "98cc");
    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "ambiguous") return;
    // The list is what fits in a message; the count must stay the truth.
    expect(resolution.matched).toBe(6);
    expect(resolution.candidates).toHaveLength(5);

    const h = createHarness(root, { mode: "rpc" });
    workflows(h.pi);
    await h.commands.get("workflows")!.handler("result 98cc", h.ctx);
    const widget = h.widgets.get("workflows") ?? "";
    expect(widget).toContain("matches 6 runs");
    expect(widget).toContain("5 of 6 shown");
  });
});

describe("/workflows result", () => {
  it("opens the entire text scrollable, addressed by the short id the panel printed", async () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const h = createHarness(root);
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    workflows(h.pi);

    await h.commands.get("workflows")!.handler("result 98cc", h.ctx);

    const first = h.customRenderFrames[0]?.join("\n") ?? "";
    expect(first).toContain("workflow result · run 20260726-212752-98cc");
    expect(first).toContain("# Code Review");
    const component = h.customComponents[0]!;
    component.handleInput?.("end");
    expect(component.render(80).join("\n")).toContain("Last line of the review");
  });

  it("defaults to the newest run and says so when there is nothing to read", async () => {
    const root = makeRoot();
    const empty = createHarness(root);
    empty.ctx.hasUI = true;
    workflows(empty.pi);
    await empty.commands.get("workflows")!.handler("result", empty.ctx);
    expect(empty.widgets.get("workflows") ?? "").toContain("No workflow run with persisted evidence was found");

    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const h = createHarness(root);
    h.ctx.hasUI = true;
    h.customInputQueue.push("escape");
    workflows(h.pi);
    await h.commands.get("workflows")!.handler("result", h.ctx);
    expect(h.customRenderFrames[0]?.join("\n") ?? "").toContain("run 20260726-212752-98cc");
  });

  it("lets /workflows status take the same short id, and names the runs when it matches several", async () => {
    const root = makeRoot();
    writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const single = createHarness(root, { mode: "rpc" });
    workflows(single.pi);
    await single.commands.get("workflows")!.handler("status 98cc", single.ctx);
    expect(single.widgets.get("workflows") ?? "").toContain("20260726-212752-98cc");

    writeFinishedRun(root, "20260725-101010-98cc", "older run");
    const ambiguous = createHarness(root, { mode: "rpc" });
    workflows(ambiguous.pi);
    await ambiguous.commands.get("workflows")!.handler("status 98cc", ambiguous.ctx);
    const widget = ambiguous.widgets.get("workflows") ?? "";
    // Two runs were found: saying "not found" would be the opposite of the truth.
    expect(widget).toContain("matches 2 runs");
    expect(widget).not.toContain("not found");
  });

  it("gives a host without custom UI the text preview plus the exact file path", async () => {
    const root = makeRoot();
    const runDir = writeFinishedRun(root, "20260726-212752-98cc", REVIEW_TEXT);
    const rpc = createHarness(root, { mode: "rpc" });
    workflows(rpc.pi);

    await rpc.commands.get("workflows")!.handler("result 98cc", rpc.ctx);

    const widget = rpc.widgets.get("workflows") ?? "";
    expect(widget).toContain("# Code Review");
    // The bounded widget may wrap a long path across lines; the path itself must
    // survive intact once the wrapping is undone, and the line count must be the
    // whole result rather than whatever fitted.
    const unwrapped = widget.replace(/\n/gu, "");
    expect(unwrapped).toContain(path.join(runDir, "result.md"));
    expect(unwrapped).toContain(`full text: ${REVIEW_TEXT.split("\n").length} line(s)`);
  });
});
