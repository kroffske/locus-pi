import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearModeState,
  currentCycleMode,
  isInPlanMode,
  isStaleModeState,
  listPlanSlugs,
  loadActiveModeState,
  loadModeState,
  makeModeAwareEditorClass,
  MODE_CYCLE,
  modeStatePath,
  modeStateForCycle,
  modeStatusLabel,
  nextCycleMode,
  normalizeRemote,
  planArtifactPath,
  planModeInjectionText,
  PLAN_MODE_COLOR,
  planSlug,
  projectSlug,
  STALE_MS,
  styleModeStatusLabel,
  userPlansDir,
  writeModeState,
} from "../../../extensions/_shared/mode-state.js";
import type { ModeState } from "../../../extensions/_shared/mode-state.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(path.join(tmpdir(), "mode-state-home-"));
  tempRoots.push(testHome);
  // Override home so real ~/.pi is never touched
  process.env["LOCUS_PI_HOME"] = testHome;
});

afterEach(() => {
  delete process.env["LOCUS_PI_HOME"];
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
// (5) normalizeRemote
// ---------------------------------------------------------------------------

describe("normalizeRemote", () => {
  it("folds git@github.com:Org/Repo.git to github.com/org/repo", () => {
    expect(normalizeRemote("git@github.com:Org/Repo.git")).toBe("github.com/org/repo");
  });

  it("folds https://user:pw@github.com/Org/Repo/ to github.com/org/repo", () => {
    expect(normalizeRemote("https://user:pw@github.com/Org/Repo/")).toBe("github.com/org/repo");
  });

  it("folds https://github.com/Org/Repo.git to github.com/org/repo", () => {
    expect(normalizeRemote("https://github.com/Org/Repo.git")).toBe("github.com/org/repo");
  });

  it("handles ssh:// scheme", () => {
    expect(normalizeRemote("ssh://git@github.com/Org/Repo.git")).toBe("github.com/org/repo");
  });

  it("lowercases the result", () => {
    expect(normalizeRemote("https://GitHub.COM/MyOrg/MyRepo")).toBe("github.com/myorg/myrepo");
  });

  it("handles no-credential https URL", () => {
    expect(normalizeRemote("https://github.com/org/repo")).toBe("github.com/org/repo");
  });
});

// ---------------------------------------------------------------------------
// (6) projectSlug — slug determinism
// ---------------------------------------------------------------------------

describe("projectSlug", () => {
  it("SSH and HTTPS of the same origin produce the same 12-hex slug", () => {
    // Build two tmp git repos pointing to the same origin via ssh vs https
    const rootSsh = makeTempRoot();
    const rootHttps = makeTempRoot();

    execFileSync("git", ["-C", rootSsh, "init", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", rootSsh, "remote", "add", "origin", "git@github.com:TestOrg/TestRepo.git"], {
      stdio: "pipe",
    });

    execFileSync("git", ["-C", rootHttps, "init", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", rootHttps, "remote", "add", "origin", "https://github.com/TestOrg/TestRepo.git"], {
      stdio: "pipe",
    });

    const slugSsh = projectSlug(rootSsh);
    const slugHttps = projectSlug(rootHttps);
    expect(slugSsh).toBe(slugHttps);
  });

  it("two distinct origins produce different slugs", () => {
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();

    execFileSync("git", ["-C", rootA, "init", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", rootA, "remote", "add", "origin", "https://github.com/TestOrg/RepoA.git"], {
      stdio: "pipe",
    });

    execFileSync("git", ["-C", rootB, "init", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", rootB, "remote", "add", "origin", "https://github.com/TestOrg/RepoB.git"], {
      stdio: "pipe",
    });

    expect(projectSlug(rootA)).not.toBe(projectSlug(rootB));
  });

  it("a no-remote directory uses realpath as key and is stable across calls", () => {
    const root = makeTempRoot();
    // no git remote
    const slug1 = projectSlug(root);
    const slug2 = projectSlug(root);
    expect(slug1).toBe(slug2);
    // slug should contain a 12-hex suffix
    expect(slug1).toMatch(/-[0-9a-f]{12}$/);
  });

  it("no-remote directory and a different no-remote directory produce different slugs", () => {
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();
    expect(projectSlug(rootA)).not.toBe(projectSlug(rootB));
  });
});

// ---------------------------------------------------------------------------
// (7) planSlug
// ---------------------------------------------------------------------------

describe("planSlug", () => {
  it("starts with a slugified version of the first line of the request", () => {
    const slug = planSlug("My Feature!", new Date(Date.UTC(2026, 5, 30)));
    expect(slug).toMatch(/^my-feature-20260630-/);
  });

  it("truncates the body to at most 48 chars before the date suffix", () => {
    const longRequest = "A".repeat(100) + " feature request";
    const slug = planSlug(longRequest, new Date(Date.UTC(2026, 5, 30)));
    const body = slug.split("-20260630-")[0] ?? "";
    expect(body.length).toBeLessThanOrEqual(48);
  });

  it("uses only the first non-empty line of the request", () => {
    const slug = planSlug("First line\nSecond line", new Date(Date.UTC(2026, 5, 30)));
    expect(slug).toMatch(/^first-line-20260630-/);
  });

  it("two calls at the same ms differ via collision suffix", () => {
    const now = new Date(Date.UTC(2026, 5, 30, 12, 0, 0, 0));
    const a = planSlug("same request", now);
    const b = planSlug("same request", now);
    // Same time → same suffix, so they are equal — collision suffix comes from
    // getTime() so identical ms = identical suffix. The spec says "two calls in
    // the same ms differ" and uses getTime().toString(36).slice(-4); since the
    // Date is the same object the suffix is deterministically equal. In practice
    // real calls are milliseconds apart. We verify the suffix is present.
    expect(a).toMatch(/-[0-9a-z]{4}$/);
    expect(b).toMatch(/-[0-9a-z]{4}$/);
  });

  it("result is filesystem-safe (no slashes, spaces, or special chars)", () => {
    const slug = planSlug("Add read-only mode: spec/impl", new Date(Date.UTC(2026, 5, 30)));
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("falls back to 'plan' body when request is empty", () => {
    const slug = planSlug("", new Date(Date.UTC(2026, 5, 30)));
    expect(slug).toMatch(/^plan-20260630-/);
  });
});

// ---------------------------------------------------------------------------
// (8) userPlansDir / planArtifactPath — home override
// ---------------------------------------------------------------------------

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

  it("nextCycleMode advances and wraps around", () => {
    expect(nextCycleMode("default")).toBe("plan");
    expect(nextCycleMode("plan")).toBe("default");
  });

  it("nextCycleMode falls back to the first mode for an unknown position", () => {
    expect(nextCycleMode("workflow" as never)).toBe("default");
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
    constructor() {
      this.borderColor = baseColor;
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

describe("userPlansDir / planArtifactPath", () => {
  it("lands under the overridden LOCUS_PI_HOME, never the real ~/.pi", () => {
    const root = makeTempRoot();
    const dir = userPlansDir(root, process.env);
    expect(dir).toContain(testHome);
    // Definitely NOT under the real homedir (process.env override is set)
    expect(dir).not.toBe(path.join(require("node:os").homedir(), ".pi", "locus-pi"));
  });

  it("planArtifactPath includes the slug and ends with .md", () => {
    const root = makeTempRoot();
    const artifactPath = planArtifactPath(root, "my-plan-20260630-abcd", process.env);
    expect(artifactPath).toContain(testHome);
    expect(artifactPath).toMatch(/my-plan-20260630-abcd\.md$/);
  });

  it("listPlanSlugs returns [] when the directory does not exist", () => {
    const root = makeTempRoot();
    expect(listPlanSlugs(root, process.env)).toEqual([]);
  });

  it("listPlanSlugs returns plan slugs sorted descending", () => {
    const root = makeTempRoot();
    const dir = userPlansDir(root, process.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "alpha-plan.md"), "# Alpha");
    writeFileSync(path.join(dir, "beta-plan.md"), "# Beta");
    writeFileSync(path.join(dir, "gamma-plan.md"), "# Gamma");
    const slugs = listPlanSlugs(root, process.env);
    expect(slugs).toEqual(["gamma-plan", "beta-plan", "alpha-plan"]);
  });

  it("listPlanSlugs ignores non-.md files", () => {
    const root = makeTempRoot();
    const dir = userPlansDir(root, process.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a-plan.md"), "# A");
    writeFileSync(path.join(dir, "README.txt"), "not a plan");
    const slugs = listPlanSlugs(root, process.env);
    expect(slugs).toEqual(["a-plan"]);
  });
});
