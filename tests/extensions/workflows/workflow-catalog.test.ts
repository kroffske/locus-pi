import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { renderOperatorBlock } from "../../../extensions/_shared/operator-ui.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogBlock,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
  readWorkflowMetaDescription,
  safeRecentWorkflowLabel,
  type WorkflowBrowserIntent,
} from "../../../extensions/workflows/workflow-catalog.js";
import { CURATED_PACKAGE_WORKFLOW_NAMES, packagedExamplesDir } from "../../../extensions/_shared/workflow-runner.js";

describe("workflow operator catalog", () => {
  it("keeps every curated Package workflow description concise and purpose-first", () => {
    const descriptions = CURATED_PACKAGE_WORKFLOW_NAMES.map((name) => ({
      name,
      description: readWorkflowMetaDescription(path.join(packagedExamplesDir(), `${name}.workflow.mjs`)),
    }));

    expect(descriptions.map(({ name }) => name)).toEqual(["live-smoke", "llm-smoke", "requirements-grill", "review"]);
    for (const { name, description } of descriptions) {
      expect(description, name).not.toMatch(/description unavailable|no description/u);
      expect(description.length, name).toBeLessThanOrEqual(96);
      expect(description, name).not.toMatch(/result\.json|journal\.ndjson|verifiable|live proof|->/iu);
      expect(description, name).toMatch(/\.$/u);
    }
  });

  it("exposes exactly the curated Package registry through the catalog model", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-curated-"));
    try {
      const packageNames = buildWorkflowCatalogModel(root, root)
        .current.filter((row) => row.source === "package")
        .map((row) => row.name);

      expect(packageNames).toEqual(["live-smoke", "llm-smoke", "requirements-grill", "review"]);
      expect(packageNames).not.toContain("plan-build-review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads only a static description on the exported top-level meta literal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-meta-"));
    const file = path.join(root, "safe.workflow.mjs");
    try {
      writeFileSync(
        file,
        [
          '// description: "comment decoy"',
          'const unrelated = { description: "unrelated decoy" };',
          'export const metadata = { description: "wrong export" };',
          'export const meta = { nested: { description: "nested decoy" }, "description": "right\\nvalue" };',
          'throw new Error("must not execute");',
        ].join("\n"),
        "utf8",
      );

      expect(readWorkflowMetaDescription(file)).toBe("right value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects computed metadata and template interpolation instead of guessing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-meta-dynamic-"));
    try {
      const computed = path.join(root, "computed.workflow.mjs");
      writeFileSync(computed, 'export const meta = makeMeta({ description: "wrong" });\n', "utf8");
      expect(readWorkflowMetaDescription(computed)).toBe("no description");

      const interpolated = path.join(root, "interpolated.workflow.mjs");
      writeFileSync(interpolated, 'const x = "secret"; export const meta = { description: `hello ${x}` };\n', "utf8");
      expect(readWorkflowMetaDescription(interpolated)).toBe("no description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps metadata scanning bounded", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-meta-bounded-"));
    const file = path.join(root, "late.workflow.mjs");
    try {
      writeFileSync(file, `${" ".repeat(70 * 1024)}export const meta = { description: "too late" };\n`, "utf8");
      expect(readWorkflowMetaDescription(file)).toBe("no description");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects persisted path targets without absolute-path disclosure", () => {
    const projectRoot = "/workspace/project";
    expect(
      safeRecentWorkflowLabel(
        { kind: "scriptPath", ref: "/workspace/project/.pi/workflows/safe.workflow.mjs" },
        projectRoot,
      ),
    ).toBe(".pi/workflows/safe.workflow.mjs");
    expect(
      safeRecentWorkflowLabel({ kind: "scriptPath", ref: "/var/folders/private/secret.workflow.mjs" }, projectRoot),
    ).toBe("secret.workflow.mjs");
    expect(
      safeRecentWorkflowLabel({ kind: "scriptPath", ref: "C:\\Users\\name\\secret.workflow.mjs" }, projectRoot),
    ).toBe("secret.workflow.mjs");
  });

  it("filters by description and returns a typed no-match state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-filter-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        'export const meta = { description: "Handles invoices" }; export default () => null;\n',
        "utf8",
      );
      writeFileSync(
        path.join(workflowDir, "beta.workflow.mjs"),
        'export const meta = { description: "Reviews releases" }; export default () => null;\n',
        "utf8",
      );

      const filtered = buildWorkflowCatalogBlock(root, root, "invoices");
      const filteredText = filtered.body?.join("\n") ?? "";
      expect(filtered.primary).toBe('Matches for "invoices".');
      expect(filteredText).toContain("[P] alpha · Handles invoices");
      expect(filteredText).not.toContain("[P] beta");
      expect(filteredText).toContain("[R] Run history:\n  (no recent matches)");
      expect(filteredText).toContain("[U] User:\n  (no matches)");

      const noMatch = buildWorkflowCatalogBlock(root, root, "definitely-no-match");
      expect(noMatch).toMatchObject({
        type: "VIEW",
        primary: 'No workflows match "definitely-no-match".',
        metadata: ["Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history"],
        controls: ["Try: /workflows list <query>"],
      });
      expect(noMatch.body?.[0]).toMatch(/^Catalog contains \d+ runnable workflow\(s\);/u);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves historical personal source under a current project shadow", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-history-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "same.workflow.mjs"),
        'export const meta = { description: "current project" }; export default () => null;\n',
        "utf8",
      );
      writeRun(root, "20260101-000002-personal", {
        kind: "name",
        ref: "same",
        source: "personal",
      });
      writeRun(root, "20260101-000001-path", {
        kind: "scriptPath",
        ref: "/var/folders/private/secret.workflow.mjs",
        source: "project",
      });

      const block = buildWorkflowCatalogBlock(root, root);
      const text = block.body?.join("\n") ?? "";
      const recent = text.slice(text.indexOf("[R] Run history:"), text.indexOf("[P] Project:"));
      expect(block).toMatchObject({
        type: "VIEW",
        subject: "Workflow catalog",
        metadata: ["Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history"],
      });
      expect(recent).toContain("[R] [U] same · historical run snapshot");
      expect(recent).toContain("[R] [P] secret.workflow.mjs · historical run snapshot");
      expect(recent).not.toContain("[R] [P] same");
      expect(text).not.toContain("/var/folders/private");
      expect(text).toContain("[P] same · current project");
      expect(text.indexOf("[R] Run history:")).toBeLessThan(text.indexOf("[P] Project:"));
      expect(text.indexOf("[P] Project:")).toBeLessThan(text.indexOf("[U] User:"));
      expect(text.indexOf("[U] User:")).toBeLessThan(text.indexOf("[PKG] Package:"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps repeated runs as distinct run-specific history rows with exact snapshot paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-repeated-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      writeRun(root, "20260101-000002-alpha", { kind: "name", ref: "alpha", source: "project" });
      writeRun(root, "20260101-000001-alpha", { kind: "name", ref: "alpha", source: "project" });

      const model = buildWorkflowCatalogModel(root, root);
      expect(model.history.map((row) => row.runId)).toEqual(["20260101-000002-alpha", "20260101-000001-alpha"]);
      expect(model.history.every((row) => row.snapshot.kind === "ready")).toBe(true);
      expect(model.history.every((row) => row.originPath.includes(row.runId))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the executed snapshot description after current metadata changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-history-description-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeRun(
        root,
        "20260101-000001-alpha",
        { kind: "name", ref: "alpha", source: "project" },
        'export const meta = { description: "Executed description" };\nexport default () => null;\n',
      );
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        'export const meta = { description: "Changed current description" };\n',
      );

      const model = buildWorkflowCatalogModel(root, root);

      expect(model.current.find((row) => row.name === "alpha")?.description).toBe("Changed current description");
      expect(model.history[0]?.description).toBe("Executed description");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds exact deterministic current and historical editor prompts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-prompts-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(path.join(workflowDir, "alpha.workflow.mjs"), 'export const meta = { description: "Alpha" };\n');
      writeRun(root, "20260101-000001-alpha", { kind: "name", ref: "alpha", source: "project" });
      const model = buildWorkflowCatalogModel(root, root);
      const current = model.current.find((row) => row.name === "alpha")!;
      const history = model.history[0]!;

      const currentState = { kind: "ready" as const, row: current, path: current.target.path, source: "source" };
      const historyState = { kind: "ready" as const, row: history, path: history.originPath, source: "source" };
      expect(buildWorkflowActionPrompt({ action: "start", row: current, sourceState: currentState })).toBe(
        [
          `Request: Start the exact current workflow at ${JSON.stringify(current.target.path)}.`,
          "Skill: $pi-workflow-authoring",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(buildWorkflowActionPrompt({ action: "edit", row: current, sourceState: currentState })).toBe(
        [
          `Request: Edit the exact current workflow at ${JSON.stringify(current.target.path)}.`,
          "Skill: $pi-workflow-authoring",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(buildWorkflowActionPrompt({ action: "review", row: current, sourceState: currentState })).toBe(
        [
          `Request: Review the exact current workflow at ${JSON.stringify(current.target.path)}.`,
          "Skill: $pi-workflow-authoring",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(buildWorkflowActionPrompt({ action: "review", row: history, sourceState: historyState })).toBe(
        [
          `Request: Review the immutable workflow snapshot for run ${JSON.stringify(history.runId)}, target "name:alpha", at ${JSON.stringify(history.originPath)}, SHA-256 ${JSON.stringify(history.snapshot.sha256)}.`,
          "Skill: $pi-workflow-authoring",
          "",
          "Additional instructions:",
          "",
        ].join("\n"),
      );
      expect(() =>
        buildWorkflowActionPrompt({
          action: "start",
          row: history,
          sourceState: historyState,
        } as unknown as WorkflowBrowserIntent),
      ).toThrow("Historical workflow actions are review-only");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains resolver, static metadata, DSL, agents, and model precedence without importing source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-info-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        path.join(workflowDir, "alpha.workflow.mjs"),
        ["globalThis.__workflowInfoImported = true;", 'export const meta = { description: "Explains alpha" };'].join(
          "\n",
        ),
      );

      const named = buildWorkflowInfoBlock(root, root, "alpha");
      const namedText = named.body?.join("\n") ?? "";
      expect(namedText).toContain(`resolved path: ${path.join(workflowDir, "alpha.workflow.mjs")}`);
      expect(namedText).toContain("static top-level export const meta.description only");
      expect(namedText).toContain("DSL: agent(), llm(), parallel(), pipeline(), phase(), log(), workflow()");
      expect(namedText).toContain('omitted agent uses role "default"');
      expect(namedText).toContain("opts.model selects the child-session model");
      expect(namedText).toContain("otherwise the active Pi session model is passed to the child executor");
      expect(namedText).toContain("llm() is a direct one-shot model call with no child session or tools");
      expect(namedText).toContain("curated Package names live-smoke, llm-smoke, requirements-grill, review");
      expect(namedText).toContain("Package files are not registered by existence");
      expect((globalThis as Record<string, unknown>).__workflowInfoImported).toBeUndefined();

      expect(buildWorkflowInfoBlock(root, root, "unknown")).toMatchObject({
        type: "WARN",
        primary: 'Unknown current workflow: "unknown".',
      });

      for (const width of [146, 80, 48]) {
        for (const block of [buildWorkflowInfoBlock(root, root), named]) {
          const rendered = renderOperatorBlock(block, width, {}, { maxLines: 34 }).join(" ");
          expect(rendered).toContain("trust:");
          expect(rendered).toContain("history:");
          expect(rendered).toContain("agent models:");
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      delete (globalThis as Record<string, unknown>).__workflowInfoImported;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeRun(
  root: string,
  runId: string,
  target: { kind: "name" | "scriptPath"; ref: string; source: "project" | "personal" | "package" },
  executedSource = `export default () => ${JSON.stringify(runId)};\n`,
): void {
  const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "journal.ndjson"), "", "utf8");
  const sha256 = createHash("sha256").update(executedSource).digest("hex");
  const snapshotPath = path.join(runDir, `script-${sha256}.workflow.mjs`);
  writeFileSync(snapshotPath, executedSource, "utf8");
  writeFileSync(
    path.join(runDir, "result.json"),
    JSON.stringify({
      runId,
      ok: true,
      result: null,
      target,
      scriptIdentity: {
        schemaVersion: 2,
        identityPolicy: "static-node-only-v1",
        sourcePath: path.join(root, ".pi", "workflows", `${target.ref}.workflow.mjs`),
        snapshotPath,
        scriptSha256: sha256,
        identityCoverage: "self-contained-static",
        executionSource: "snapshot",
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        builtinImports: [],
        unboundDependencies: [],
      },
    }),
    "utf8",
  );
}
