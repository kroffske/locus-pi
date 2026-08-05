import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import statusLine from "../../../extensions/status-line/index.js";
import {
  aggregateSessionUsage,
  detectLinkedWorktree,
  LocusFooterComponent,
  renderStatusLine,
  type StatusLineSnapshot,
} from "../../../extensions/status-line/footer.js";
import { createHarness, emit } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(overrides: Partial<StatusLineSnapshot> = {}): StatusLineSnapshot {
  return {
    model: "gpt-5.6-sol high",
    cwd: "~/projects/locus-pi",
    worktree: "codex-subagent-interactive-view",
    branch: "codex/subagent-interactive-view",
    contextTokens: 63_200,
    contextWindow: 200_000,
    contextPercent: 31.6,
    usage: { input: 182_400, output: 24_800 },
    extensionStatuses: ["PLAN · doing"],
    compaction: { kind: "idle" },
    ...overrides,
  };
}

describe("status-line footer", () => {
  it("projects one readable line at wide, medium, and narrow widths", () => {
    const wide = renderStatusLine(snapshot(), 240);
    expect(wide).toContain("~/projects/locus-pi");
    expect(wide).toContain("wt:codex-subagent-interactive-view");
    expect(wide).toContain("git:codex/subagent-interactive-view");
    expect(wide).toContain("ctx:63.2k/200k 31.6%");
    expect(wide).toContain("↑182.4k ↓24.8k");
    expect(wide).toContain("compact:Pi");
    expect(wide).toContain("PLAN · doing");

    const medium = renderStatusLine(snapshot(), 100);
    expect(medium).toContain("locus-pi");
    expect(medium).toContain("ctx:31.6%/200k");
    expect(medium).toContain("compact:Pi");

    const narrow = renderStatusLine(snapshot(), 48);
    expect(narrow.length).toBeLessThanOrEqual(48);
    expect(narrow).toContain("gpt-5.6-sol high");
    expect(narrow).toContain("ctx31.6%");
    expect(narrow).not.toContain("PLAN");
  });

  it("aggregates assistant, tool-result, compaction, and branch-summary usage", () => {
    expect(
      aggregateSessionUsage([
        { type: "message", message: { role: "assistant", usage: { input: 100, output: 25 } } },
        { type: "message", message: { role: "toolResult", usage: { input: 10, output: 5 } } },
        { type: "compaction", usage: { input: 40, output: 12 } },
        { type: "branch_summary", usage: { input: 30, output: 8 } },
        { type: "message", message: { role: "user", usage: { input: 999, output: 999 } } },
      ]),
    ).toEqual({ input: 180, output: 50 });
  });

  it("detects only linked Git worktrees from the .git indirection file", () => {
    const linked = mkdtempSync(path.join(tmpdir(), "locus-status-linked-"));
    const ordinary = mkdtempSync(path.join(tmpdir(), "locus-status-main-"));
    roots.push(linked, ordinary);
    mkdirSync(path.join(linked, "nested"));
    writeFileSync(path.join(linked, ".git"), "gitdir: /repo/.git/worktrees/work-3\n", "utf8");
    mkdirSync(path.join(ordinary, ".git"));
    expect(detectLinkedWorktree(path.join(linked, "nested"))).toBe("work-3");
    expect(detectLinkedWorktree(ordinary)).toBeUndefined();
  });

  it("renders honest compacting and post-compaction measuring states", () => {
    expect(renderStatusLine(snapshot({ compaction: { kind: "compacting" } }), 180)).toContain("COMPACTING");
    expect(
      renderStatusLine(
        snapshot({ contextTokens: null, compaction: { kind: "compacted", tokensBefore: 182_000, completedAt: 1 } }),
        180,
      ),
    ).toContain("COMPACTED · 182k → measuring…");
  });

  it("installs one violet footer in TUI mode and restores Pi's footer on shutdown", async () => {
    const harness = createHarness();
    harness.ctx.model = { provider: "openai", id: "gpt-5.6-sol", contextWindow: 200_000 };
    harness.ctx.thinkingLevel = "high";
    harness.ctx.getContextUsage = () => ({ tokens: 10_000, contextWindow: 200_000, percent: 5 });
    statusLine(harness.pi);
    await emit(harness, "session_start");
    expect(harness.footerFactory).toBeTypeOf("function");

    const requestRender = vi.fn();
    const unsubscribe = vi.fn();
    const component = harness.footerFactory?.(
      { requestRender, terminal: { rows: 30, columns: 120 } },
      { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      {
        getGitBranch: () => "codex/status-line",
        getExtensionStatuses: () => new Map([["locus", "PLAN · doing"]]),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => unsubscribe,
      },
    );
    const rendered = component?.render(120) ?? [];
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("\u001b[48;2;42;27;61m");
    expect(rendered[0]).toContain("gpt-5.6-sol high");
    expect(component?.render(40)[0]?.match(/\u001b\[0m/gu)).toHaveLength(1);

    await emit(harness, "session_before_compact", { reason: "threshold" });
    expect(component?.render(120)[0]).toContain("COMPACTING");
    await emit(harness, "session_compact", { compactionEntry: { tokensBefore: 182_000 } });
    expect(component?.render(160)[0]).toContain("COMPACTED");
    await emit(harness, "session_shutdown");
    expect(harness.footerFactory).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
