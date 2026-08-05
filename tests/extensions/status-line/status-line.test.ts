import { describe, expect, it, vi } from "vitest";
import statusLine from "../../../extensions/status-line/index.js";
import {
  LocusFooterComponent,
  renderStatusLine,
  type StatusLineSnapshot,
} from "../../../extensions/status-line/footer.js";
import { createHarness, emit } from "../../test-harness.js";

function snapshot(overrides: Partial<StatusLineSnapshot> = {}): StatusLineSnapshot {
  return {
    model: "gpt-5.6-sol",
    effort: "high",
    cwd: "~/projects/locus-pi",
    branch: "codex/subagent-interactive-view",
    contextTokens: 63_200,
    contextWindow: 200_000,
    contextPercent: 31.6,
    compaction: { kind: "idle" },
    ...overrides,
  };
}

describe("status-line footer", () => {
  it("projects one readable line at wide, medium, and narrow widths", () => {
    const wide = renderStatusLine(snapshot(), 240);
    expect(wide.startsWith("~/projects/locus-pi (codex/subagent-interactive-view)")).toBe(true);
    expect(wide.endsWith("31.6%/200k (pi:auto) gpt-5.6-sol high")).toBe(true);
    expect(wide).not.toContain("tok:");
    expect(wide).not.toContain("ctx:");
    expect(wide).not.toContain("git:");

    const medium = renderStatusLine(snapshot(), 100);
    expect(medium.startsWith("~/projects/locus-pi (codex/subagent-interactive-view)")).toBe(true);
    expect(medium.endsWith("31.6%/200k (pi:auto) gpt-5.6-sol high")).toBe(true);

    const narrow = renderStatusLine(snapshot(), 48);
    expect(narrow).toHaveLength(48);
    expect(narrow.startsWith("locus-pi")).toBe(true);
    expect(narrow.endsWith("31.6%/200k (pi:auto) gpt-5.6-sol high")).toBe(true);
  });

  it("renders honest compacting and post-compaction measuring states", () => {
    expect(renderStatusLine(snapshot({ compaction: { kind: "compacting" } }), 180)).toContain("COMPACTING");
    expect(
      renderStatusLine(
        snapshot({ contextTokens: null, compaction: { kind: "compacted", tokensBefore: 182_000, completedAt: 1 } }),
        180,
      ),
    ).toContain("(COMPACTED 182k→measuring…)");
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
    expect(rendered[0]).toContain("5%/200k (pi:auto) gpt-5.6-sol high");
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
