/**
 * Characterization of the `/workflows` operator surfaces that no other test
 * pinned: the help block, the unknown-command fallback, the disk-backed run
 * list (empty and populated, compact and wide), the explicit-stop block, and
 * the argument-parse rejections for `--resume` / `--answer`.
 *
 * Written against the pre-split tree so the T-126 move of these blocks out of
 * `extensions/workflows/index.ts` has evidence that the rendered text did not
 * change.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workflowRunDir } from "../../../extensions/workflows/runtime/workflow-journal.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness, type Harness } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-command-surfaces-"));
  roots.push(root);
  return root;
}

/** One finished run on disk: a journal Pi can replay and a persisted envelope. */
function writeRun(root: string, runId: string): void {
  const runDir = workflowRunDir(root, runId);
  mkdirSync(runDir, { recursive: true });
  const journal = [
    { ts: "2026-07-26T21:27:52.000Z", runId, kind: "phase", phase: "review" },
    { ts: "2026-07-26T21:27:53.000Z", runId, kind: "agent_start", agent: "reviewer", label: "pass 1" },
    {
      ts: "2026-07-26T21:27:54.000Z",
      runId,
      kind: "agent_end",
      agent: "reviewer",
      status: "completed",
      durationMs: 1200,
    },
    { ts: "2026-07-26T21:27:55.000Z", runId, kind: "log", source: "script", message: "wrote findings" },
  ];
  writeFileSync(
    path.join(runDir, "journal.ndjson"),
    `${journal.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify({ runId, ok: true, result: { summary: "review done" }, journal: [] }, null, 2)}\n`,
    "utf8",
  );
}

function widgetOf(h: Harness): string {
  return h.widgets.get("workflows") ?? "";
}

async function runCommand(h: Harness, text: string): Promise<string> {
  await h.commands.get("workflows")!.handler(text, h.ctx);
  return widgetOf(h);
}

/** A tui host with no custom UI: the wide, non-compact passive blocks. */
function wideHarness(root: string): Harness {
  const h = createHarness(root);
  delete h.ctx.ui.custom;
  workflows(h.pi);
  return h;
}

function compactHarness(root: string): Harness {
  const h = createHarness(root, { mode: "rpc" });
  workflows(h.pi);
  return h;
}

describe("/workflows help and unknown commands", () => {
  it("answers bare /workflows with the command list when nothing needs an answer", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "");

    expect(widget).toContain("No workflow needs an answer");
    expect(widget).toContain("Dashboard: /workflows dashboard");
    expect(widget).toContain("Catalog: /workflow-list [query]");
    expect(widget).toContain("Continue: /workflow-continue <runId> [--answer <text>]");
    expect(widget).toContain("A command starts execution only when the Pi session is provably idle.");
  });

  it("names an unknown subcommand and prints the usage line", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "frobnicate");

    expect(widget).toContain("Unknown workflow command: frobnicate");
    expect(widget).toContain("Usage: /workflows | dashboard | list [query]");
    expect(widget).not.toContain("Available curated Package workflows");
  });

  it("lists the curated names when the unknown command started with run", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run");

    expect(widget).toContain("Unknown workflow command: run");
    expect(widget).toContain("Available curated Package workflows:");
    expect(widget).toContain("review");
  });
});

describe("/workflows status run list", () => {
  it("says there is nothing yet and offers the first run", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "status");

    expect(widget).toContain("No workflow runs yet.");
    expect(widget).toContain("status: ok; total=0 shown=0 older=0");
    expect(widget).toContain('Run one: /workflows run requirements-grill "<your request>"');
  });

  it("renders one wide row per run with the agent and status columns", async () => {
    const root = makeRoot();
    writeRun(root, "20260726-212752-98cc");
    const widget = await runCommand(wideHarness(root), "status");

    expect(widget).toContain("Showing 1 newest of 1 workflow run(s).");
    expect(widget).toContain("20260726-212752-98cc");
    expect(widget).toContain("phase=review");
    expect(widget).toContain("agents=1/1");
    expect(widget).toContain("Detail: /workflows status <runId>");
  });

  it("keeps a compact host to the bounded newest rows", async () => {
    const root = makeRoot();
    for (const index of [1, 2, 3, 4, 5]) writeRun(root, `2026072${index}-101010-98c${index}`);
    const widget = await runCommand(compactHarness(root), "status");

    // WORKFLOW_RPC_STATUS_ROWS bounds the compact list at 4 of the 5 runs.
    expect(widget).toContain("Showing 4 newest of 5 workflow run(s).");
    expect(widget).toContain("+1 older run(s) hidden");
    expect(widget).toContain("20260725-101010-98c5");
  });

  it("renders one run's journal detail newest-first with its run directory", async () => {
    const root = makeRoot();
    writeRun(root, "20260726-212752-98cc");
    const widget = await runCommand(wideHarness(root), "status 20260726-212752-98cc");

    expect(widget).toContain("20260726-212752-98cc");
    expect(widget).toContain("[script] wrote findings");
    expect(widget).toContain("[agent] <- reviewer completed 1200ms");
    expect(widget).toContain("[phase] review");
    // The bounded widget wraps a long path across framed lines; the path itself
    // must survive intact once the frame and the wrapping are undone.
    const unwrapped = widget.replace(/[│╭╮╰╯─]/gu, "").replace(/\s+/gu, "");
    expect(unwrapped).toContain(`runDir:${workflowRunDir(root, "20260726-212752-98cc")}`);
    expect(unwrapped).toContain('result:{"summary":"reviewdone"}');
  });

  it("reports a run id that has no evidence on disk as not found", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "status 20260726-000000-zzzz");

    expect(widget).toContain("Workflow run not found: 20260726-000000-zzzz");
    expect(widget).toContain("Recovery: /workflows status");
  });
});

describe("/workflows stop", () => {
  it("says nothing matched when no run answers the selector", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "stop 20260726-000000-zzzz");

    expect(widget).toContain("No active or recorded workflow matched 20260726-000000-zzzz.");
    expect(widget).toContain("Inspect durable runs: /workflows status");
    expect(widget).toContain("Stop the current run: /workflows stop last");
  });
});

describe("/workflows argument rejections", () => {
  it("rejects --resume with no run id after it", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "run alpha --resume");

    expect(widget).toContain("Missing run id after --resume.");
    expect(widget).toContain("Retry: /workflows run <name|path> --resume <runId> [input]");
    expect(widget).toContain("No workflow execution was started.");
  });

  it("requires a source run id for a continuation", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "continue");

    expect(widget).toContain("Workflow continuation requires a source run id.");
    expect(widget).toContain("Retry: /workflow-continue <runId> [--answer <text>]");
  });

  it("rejects --answer with no text after it", async () => {
    const widget = await runCommand(wideHarness(makeRoot()), "continue 20260726-212752-98cc --answer");

    expect(widget).toContain("Missing text after --answer.");
    expect(widget).toContain("Retry: /workflow-continue <runId> --answer <text>");
  });

  it("says so when a named continuation has no actionable handoff", async () => {
    const root = makeRoot();
    writeRun(root, "20260726-212752-98cc");
    const widget = await runCommand(wideHarness(root), "continue 20260726-212752-98cc --answer yes");

    expect(widget).toContain("No actionable workflow handoff was found for 20260726-212752-98cc.");
    expect(widget).toContain("Inspect durable evidence: /workflow-status <runId>");
  });
});
