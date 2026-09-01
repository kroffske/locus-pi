import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearModeState,
  currentCycleMode,
  isInPlanMode,
  isStaleModeState,
  loadActiveModeState,
  loadModeState,
  makeModeAwareEditorClass,
  MODE_CYCLE,
  modeStatePath,
  modeStateForCycle,
  modeStatusLabel,
  planModeInjectionText,
  PLAN_MODE_COLOR,
  STALE_MS,
  styleModeStatusLabel,
  writeModeState,
} from "../../../../extensions/plan/mode/mode-state.js";
import type { ModeState } from "../../../../extensions/plan/mode/mode-state.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mode-state-project-"));
  tempRoots.push(root);
  return root;
}

function sampleState(overrides: Partial<ModeState> = {}): ModeState {
  return {
    version: 1,
    mode: "plan",
    slug: "my-feature-20260630-abcd",
    activeArtifactPath: "/home/user/.pi/locus-pi/proj-abc/plans/my-feature-20260630-abcd.md",
    enteredAt: new Date().toISOString(),
    status: "active",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) loadModeState — missing / corrupt / round-trip
// ---------------------------------------------------------------------------

describe("loadModeState", () => {
  it("returns null when the state file is missing", () => {
    const root = makeTempRoot();
    expect(loadModeState(root)).toBeNull();
  });

  it("returns null when the state file contains corrupt JSON", () => {
    const root = makeTempRoot();
    const filePath = modeStatePath(root);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not valid json %%% ]");
    expect(loadModeState(root)).toBeNull();
  });

  it("returns null when the state file has invalid structure (wrong version)", () => {
    const root = makeTempRoot();
    const filePath = modeStatePath(root);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        mode: "plan",
        slug: "x",
        activeArtifactPath: "",
        enteredAt: new Date().toISOString(),
        status: "active",
      }),
    );
    expect(loadModeState(root)).toBeNull();
  });

  it("returns null when mode field is an unrecognized string", () => {
    const root = makeTempRoot();
    const filePath = modeStatePath(root);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        mode: "unknown-mode",
        slug: "x",
        activeArtifactPath: "",
        enteredAt: "",
        status: "active",
      }),
    );
    expect(loadModeState(root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) writeModeState → loadModeState round-trip
// ---------------------------------------------------------------------------

describe("writeModeState / loadModeState round-trip", () => {
  it("persists and reloads a full ModeState", () => {
    const root = makeTempRoot();
    const state = sampleState();
    writeModeState(root, state);
    const loaded = loadModeState(root);
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(state);
  });

  it("creates parent directories automatically", () => {
    const root = makeTempRoot();
    // No .locus/runtime/mode/ directory exists yet
    writeModeState(root, sampleState());
    expect(loadModeState(root)).not.toBeNull();
  });

  it("round-trips mode: null (cleared sentinel)", () => {
    const root = makeTempRoot();
    writeModeState(root, { version: 1, mode: null, slug: "", activeArtifactPath: "", enteredAt: "", status: "draft" });
    const loaded = loadModeState(root);
    expect(loaded?.mode).toBeNull();
    expect(loaded?.status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// (3) clearModeState
// ---------------------------------------------------------------------------

describe("clearModeState", () => {
  it("writes the cleared sentinel and isInPlanMode returns false", () => {
    const root = makeTempRoot();
    // First write an active plan state
    writeModeState(root, sampleState({ mode: "plan", status: "active" }));
    expect(isInPlanMode(loadModeState(root))).toBe(true);

    // Clear it
    clearModeState(root);
    const loaded = loadModeState(root);
    expect(loaded).not.toBeNull();
    expect(loaded?.mode).toBeNull();
    expect(isInPlanMode(loaded)).toBe(false);
  });

  it("leaves a valid state.json file (not ENOENT) after clear", () => {
    const root = makeTempRoot();
    clearModeState(root);
    const loaded = loadModeState(root);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (4) Staleness
// ---------------------------------------------------------------------------

describe("isStaleModeState / loadActiveModeState", () => {
  it("considers a record with ancient enteredAt as stale", () => {
    const root = makeTempRoot();
    const ancient = new Date(Date.now() - STALE_MS - 10_000).toISOString();
    const state = sampleState({ mode: "plan", enteredAt: ancient });
    writeModeState(root, state);

    expect(isStaleModeState(state)).toBe(true);
    // loadActiveModeState returns null for stale active records
    expect(loadActiveModeState(root)).toBeNull();
    // But raw loadModeState still returns the record (diagnostics path)
    expect(loadModeState(root)).not.toBeNull();
    expect(loadModeState(root)?.enteredAt).toBe(ancient);
  });

  it("does not consider a fresh enteredAt as stale", () => {
    const root = makeTempRoot();
    const fresh = new Date().toISOString();
    const state = sampleState({ mode: "plan", enteredAt: fresh });
    writeModeState(root, state);

    expect(isStaleModeState(state)).toBe(false);
    expect(loadActiveModeState(root)).not.toBeNull();
    expect(loadActiveModeState(root)?.mode).toBe("plan");
  });

  it("does not consider a null-mode record stale regardless of enteredAt", () => {
    const root = makeTempRoot();
    const ancient = new Date(0).toISOString();
    const state: ModeState = {
      version: 1,
      mode: null,
      slug: "",
      activeArtifactPath: "",
      enteredAt: ancient,
      status: "draft",
    };
    writeModeState(root, state);
    expect(isStaleModeState(state)).toBe(false);
    expect(loadActiveModeState(root)).not.toBeNull();
  });

  it("isStaleModeState is false just inside the window", () => {
    const state = sampleState({ enteredAt: new Date(Date.now() - STALE_MS + 5_000).toISOString() });
    expect(isStaleModeState(state)).toBe(false);
  });

  it("isStaleModeState is true just outside the window", () => {
    const state = sampleState({ enteredAt: new Date(Date.now() - STALE_MS - 5_000).toISOString() });
    expect(isStaleModeState(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (9) Mode cycle (T-A)
// ---------------------------------------------------------------------------

describe("mode cycle", () => {
  it("MODE_CYCLE starts at default and includes plan", () => {
    expect(MODE_CYCLE[0]).toBe("default");
    expect(MODE_CYCLE).toContain("plan");
  });

  it("currentCycleMode maps state to a cycle position", () => {
    expect(currentCycleMode(null)).toBe("default");
    expect(
      currentCycleMode({ version: 1, mode: null, slug: "", activeArtifactPath: "", enteredAt: "", status: "draft" }),
    ).toBe("default");
    expect(currentCycleMode(sampleState({ mode: "plan" }))).toBe("plan");
  });

  it("modeStateForCycle('plan') arms plan mode with an empty slug and active status", () => {
    const state = modeStateForCycle("plan", new Date(Date.UTC(2026, 5, 30)));
    expect(state.mode).toBe("plan");
    expect(state.slug).toBe("");
    expect(state.status).toBe("active");
    expect(isInPlanMode(state)).toBe(true);
  });

  it("modeStateForCycle('default') yields a cleared sentinel", () => {
    const state = modeStateForCycle("default");
    expect(state.mode).toBeNull();
    expect(isInPlanMode(state)).toBe(false);
  });

  it("round-trips a cycle into plan and back to default via writeModeState", () => {
    const root = makeTempRoot();
    writeModeState(root, modeStateForCycle("plan"));
    expect(currentCycleMode(loadModeState(root))).toBe("plan");
    writeModeState(root, modeStateForCycle("default"));
    expect(currentCycleMode(loadModeState(root))).toBe("default");
  });

  it("modeStatusLabel reflects the active mode", () => {
    expect(modeStatusLabel(null)).toBeUndefined();
    expect(modeStatusLabel(modeStateForCycle("plan"))).toBe("PLAN");
    expect(modeStatusLabel(sampleState({ mode: "plan", slug: "my-feature" }))).toBe("PLAN — my-feature");
  });
});

describe("styleModeStatusLabel", () => {
  const theme = {
    fg: (color: string, text: string) => `<fg:${color}>${text}</fg>`,
    bold: (text: string) => `<b>${text}</b>`,
  };

  it("returns plain text when no theme (test harness / non-interactive)", () => {
    expect(styleModeStatusLabel("PLAN")).toBe("PLAN");
    expect(styleModeStatusLabel("PLAN", undefined)).toBe("PLAN");
  });

  it("wraps the label in bold + the plan color when a theme is present", () => {
    expect(styleModeStatusLabel("PLAN", theme)).toBe(`<b><fg:${PLAN_MODE_COLOR}>PLAN</fg></b>`);
  });
});

describe("makeModeAwareEditorClass", () => {
  const planColor = (s: string) => `PLAN(${s})`;
  const baseColor = (s: string) => `BASE(${s})`;

  // Mimics Pi's Editor: declares borderColor as a class field and assigns the
  // theme's border color in the constructor (the field-shadow case the helper
  // must defeat by redefining borderColor as an own accessor after super()).
  class FakeEditor {
    borderColor: (s: string) => string;
    historyIndex = -1;
    state = { lines: [""], cursorLine: 0, cursorCol: 0 };
    scrollOffset = 0;
    constructor() {
      this.borderColor = baseColor;
    }
    navigateHistory(_direction: number) {
      this.historyIndex = 0;
      this.state = { lines: ["first", "last"], cursorLine: 0, cursorCol: 0 };
    }
    setCursorCol(column: number) {
      this.state.cursorCol = column;
    }
  }

  function makeActiveFlag() {
    const flag = { active: false };
    return flag;
  }

  it("returns the base color while plan mode is inactive", () => {
    const flag = makeActiveFlag();
    const ModeAware = makeModeAwareEditorClass(FakeEditor, planColor, () => flag.active);
    const editor = new ModeAware() as { borderColor: (s: string) => string };
    expect(editor.borderColor("─")).toBe("BASE(─)");
  });

  it("returns the plan color while plan mode is active", () => {
    const flag = makeActiveFlag();
    const ModeAware = makeModeAwareEditorClass(FakeEditor, planColor, () => flag.active);
    const editor = new ModeAware() as { borderColor: (s: string) => string };
    flag.active = true;
    expect(editor.borderColor("─")).toBe("PLAN(─)");
  });

  it("captures host border-color reassignment as the new base (restored on plan exit)", () => {
    const flag = makeActiveFlag();
    const ModeAware = makeModeAwareEditorClass(FakeEditor, planColor, () => flag.active);
    const editor = new ModeAware() as { borderColor: (s: string) => string };
    // Pi reassigns borderColor on thinking/bash changes — our setter captures it.
    editor.borderColor = (s: string) => `THINK(${s})`;
    flag.active = true;
    expect(editor.borderColor("─")).toBe("PLAN(─)"); // plan dominates while active
    flag.active = false;
    expect(editor.borderColor("─")).toBe("THINK(─)"); // restored captured base
  });

  it("recalls command history with the cursor at the end instead of the first character", () => {
    const ModeAware = makeModeAwareEditorClass(FakeEditor, planColor, () => false);
    const editor = new ModeAware() as FakeEditor;

    editor.navigateHistory(-1);

    expect(editor.state).toMatchObject({ cursorLine: 1, cursorCol: 4 });
  });
});

describe("planModeInjectionText", () => {
  it("frames planning and explicitly allows commands/scripts (no read-only block)", () => {
    const text = planModeInjectionText(null);
    expect(text).toContain("<planning_mode>");
    expect(text).toContain("PLANNING mode");
    expect(text.toLowerCase()).toContain("throwaway script");
    expect(text).toContain("Do NOT implement");
    expect(text).toContain("</planning_mode>");
  });

  it("names the active plan slug when present", () => {
    expect(planModeInjectionText(sampleState({ slug: "my-plan" }))).toContain("my-plan");
  });
});
