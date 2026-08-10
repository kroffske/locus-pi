import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listWorkflowCatalogTargets,
  packagedExamplesDir,
  resolveWorkflowTarget,
  runWorkflowScript,
  WorkflowNameNotFoundError,
} from "../../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../../test-harness.js";

describe("workflow target physical confinement", () => {
  it("rejects an explicit external symlink before its module can be evaluated", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-confined-project-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-confined-outside-"));
    const marker = path.join(outside, "evaluated.marker");
    try {
      const externalScript = path.join(outside, "external.workflow.mjs");
      writeFileSync(
        externalScript,
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(marker)}, 'evaluated', 'utf8');`,
          "export default function() { return { escaped: true }; }",
          "",
        ].join("\n"),
        "utf8",
      );
      symlinkSync(externalScript, path.join(root, "escape.workflow.mjs"));

      expect(() => resolveWorkflowTarget({ scriptPath: "escape.workflow.mjs" }, root, root)).toThrow(
        /escapes project root through a symlink/u,
      );

      const harness = createHarness(root, { sessionId: "wf-confined-explicit" });
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "escape.workflow.mjs",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/escapes project root through a symlink/u);
      expect(existsSync(marker)).toBe(false);
      expect(JSON.parse(readFileSync(result.resultPersistence.path, "utf8"))).toMatchObject({ ok: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a project saved-name symlink instead of falling through to another source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-confined-name-"));
    const outside = mkdtempSync(path.join(tmpdir(), "wf-confined-name-outside-"));
    try {
      const projectWorkflows = path.join(root, ".pi", "workflows");
      mkdirSync(projectWorkflows, { recursive: true });
      const externalScript = path.join(outside, "named.workflow.mjs");
      writeFileSync(externalScript, "export default () => ({ escaped: true });\n", "utf8");
      symlinkSync(externalScript, path.join(projectWorkflows, "named.workflow.mjs"));

      expect(() => resolveWorkflowTarget({ name: "named" }, root, root)).toThrow(
        /escapes project root through a symlink/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows internal symlinks under a symlinked project root and preserves lexical paths", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "wf-confined-internal-"));
    const physicalRoot = path.join(parent, "physical-project");
    const projectAlias = path.join(parent, "project-alias");
    try {
      const actualScript = path.join(physicalRoot, "actual", "inside.workflow.mjs");
      mkdirSync(path.dirname(actualScript), { recursive: true });
      mkdirSync(path.join(physicalRoot, ".pi", "workflows"), { recursive: true });
      writeFileSync(actualScript, "export default () => ({ inside: true });\n", "utf8");
      symlinkSync(physicalRoot, projectAlias);
      symlinkSync(actualScript, path.join(physicalRoot, "entry.workflow.mjs"));
      symlinkSync(actualScript, path.join(physicalRoot, ".pi", "workflows", "inside.workflow.mjs"));

      const explicit = resolveWorkflowTarget({ scriptPath: "entry.workflow.mjs" }, projectAlias, projectAlias);
      const named = resolveWorkflowTarget({ name: "inside" }, projectAlias, projectAlias);
      expect(explicit.path).toBe(path.join(projectAlias, "entry.workflow.mjs"));
      expect(named).toMatchObject({
        source: "project",
        path: path.join(projectAlias, ".pi", "workflows", "inside.workflow.mjs"),
      });

      const harness = createHarness(projectAlias, { sessionId: "wf-confined-internal" });
      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "entry.workflow.mjs",
      });
      expect(result).toMatchObject({ ok: true, result: { inside: true } });
      expect(result.target?.path).toBe(path.join(projectAlias, "entry.workflow.mjs"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("preserves missing and dangling paths, lexical containment, personal, and packaged sources", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-confined-sources-"));
    const home = mkdtempSync(path.join(tmpdir(), "wf-confined-home-"));
    const previousHome = process.env.HOME;
    try {
      const missing = resolveWorkflowTarget({ scriptPath: "missing.workflow.mjs" }, root, root);
      expect(missing.path).toBe(path.join(root, "missing.workflow.mjs"));
      const danglingPath = path.join(root, "dangling.workflow.mjs");
      symlinkSync(path.join(root, "absent-target.workflow.mjs"), danglingPath);
      expect(resolveWorkflowTarget({ scriptPath: "dangling.workflow.mjs" }, root, root).path).toBe(danglingPath);
      const danglingHarness = createHarness(root, { sessionId: "wf-confined-dangling" });
      const danglingResult = await runWorkflowScript({
        pi: danglingHarness.pi,
        ctx: danglingHarness.ctx,
        signal: new AbortController().signal,
        scriptPath: "dangling.workflow.mjs",
      });
      expect(danglingResult.ok).toBe(false);
      expect(() => resolveWorkflowTarget({ scriptPath: "../escape.workflow.mjs" }, root, root)).toThrow(/escapes/u);

      process.env.HOME = home;
      const personalDir = path.join(home, ".pi", "workflows");
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(path.join(personalDir, "personal.workflow.mjs"), "export default () => 'personal';\n", "utf8");
      expect(resolveWorkflowTarget({ name: "personal" }, root, root)).toMatchObject({
        source: "personal",
        path: path.join(personalDir, "personal.workflow.mjs"),
      });

      expect(resolveWorkflowTarget({ name: "live-smoke" }, root, root)).toMatchObject({
        source: "package",
        path: path.join(packagedExamplesDir(), "live-smoke.workflow.mjs"),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * T-112 — the docs used to call `.claude/workflows/` an interop source for
 * foreign workflows. It is not one: these directories accept exactly the
 * pi-native `<name>.workflow.mjs`, which is what the narrowed wording now says.
 * This test is what that claim resolves to, and it is what must be changed
 * deliberately if the still-open `.js` decision is ever implemented.
 */
describe("interop-directory file layout", () => {
  const withProject = (run: (root: string) => void): void => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-interop-"));
    const previousHome = process.env.HOME;
    try {
      // Keep a real personal directory out of the resolution path.
      process.env.HOME = path.join(root, "home");
      mkdirSync(path.join(root, ".claude", "workflows"), { recursive: true });
      run(root);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("does not resolve a foreign host's <name>.js dropped into .claude/workflows", () => {
    withProject((root) => {
      writeFileSync(
        path.join(root, ".claude", "workflows", "foreign.js"),
        "export default async function () { return args; }\n",
        "utf8",
      );

      expect(() => resolveWorkflowTarget({ name: "foreign" }, root, root)).toThrow(WorkflowNameNotFoundError);
      expect(listWorkflowCatalogTargets(root, root).map((target) => target.ref)).not.toContain("foreign");
    });
  });

  it("resolves a pi-native <name>.workflow.mjs there as an ordinary project source", () => {
    withProject((root) => {
      const file = path.join(root, ".claude", "workflows", "native.workflow.mjs");
      writeFileSync(file, 'export const meta = { description: "d." };\nexport default () => "native";\n', "utf8");

      expect(resolveWorkflowTarget({ name: "native" }, root, root)).toMatchObject({
        kind: "name",
        ref: "native",
        source: "project",
        path: file,
      });
    });
  });

  it("never lets a sibling .js win over the accepted .mjs", () => {
    withProject((root) => {
      const dir = path.join(root, ".claude", "workflows");
      writeFileSync(path.join(dir, "both.js"), "export default () => 'js';\n", "utf8");
      writeFileSync(path.join(dir, "both.workflow.mjs"), "export default () => 'mjs';\n", "utf8");

      expect(resolveWorkflowTarget({ name: "both" }, root, root).path).toBe(path.join(dir, "both.workflow.mjs"));
    });
  });
});
