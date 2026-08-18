import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../extensions/_shared/host/pi-api.js";
import { loadExtensionAgentCatalog } from "../../extensions/agents/catalog.js";
import { packagedWorkflowNames } from "../../extensions/workflows/runtime/workflow-runner.js";
import { createHarness } from "../test-harness.js";

interface PackageJson {
  files: string[];
  license: string;
  pi: { extensions: string[] };
  repository: { url: string };
}
interface ExtensionManifest {
  docsPath: string;
  provides: { tools: string[]; commands: string[]; hooks: string[]; shortcuts?: string[] };
  risk: string;
  sourceAuditPath: string | null;
  tests: string[];
}
interface ExtensionDocRow {
  tools: string[];
  commands: string[];
  hooks: string[];
  risk: string;
  manual: string;
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
const extensionDocs = readFileSync(path.join(root, "docs/extensions.md"), "utf8");
const workflowDocs = readFileSync(path.join(root, "docs/workflows.md"), "utf8");
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

function extensionIdFromEntrypoint(entrypoint: string): string {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/.exec(entrypoint);
  if (!match?.[1]) throw new Error(`invalid default extension entrypoint: ${entrypoint}`);
  return match[1];
}

function inlineCodeList(value: string): string[] {
  if (value === "—") return [];
  const items = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  if (items.length === 0) throw new Error(`expected inline-code list or em dash, received: ${value}`);
  return items;
}

function parseExtensionRows(markdown: string): Map<string, ExtensionDocRow> {
  const rows = new Map<string, ExtensionDocRow>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const columns = line
      .split("|")
      .slice(1, -1)
      .map((column) => column.trim());
    if (columns.length !== 6) throw new Error(`invalid extension reference row: ${line}`);
    const id = /^`([^`]+)`$/.exec(columns[0] ?? "")?.[1];
    const manual = /\[`([^`]+)`\]\([^)]+\)/.exec(columns[5] ?? "")?.[1];
    if (!id || !manual) throw new Error(`invalid extension reference row: ${line}`);
    rows.set(id, {
      tools: inlineCodeList(columns[1] ?? ""),
      commands: inlineCodeList(columns[2] ?? ""),
      hooks: inlineCodeList(columns[3] ?? ""),
      risk: columns[4] ?? "",
      manual,
    });
  }
  return rows;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function importedSpecifiers(filePath: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (node.arguments.length === 1 && argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifiers.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function featureDependencyGraph(extensionIds: string[]): Map<string, string[]> {
  return new Map(
    extensionIds.map((sourceId) => {
      const dependencies = new Set<string>();
      for (const filePath of sourceFiles(path.join(root, "extensions", sourceId))) {
        for (const specifier of importedSpecifiers(filePath)) {
          if (!specifier.startsWith(".")) continue;
          const [topLevel, targetId] = path
            .relative(root, path.resolve(path.dirname(filePath), specifier))
            .split(path.sep);
          if (topLevel === "extensions" && targetId && targetId !== "_shared" && targetId !== sourceId)
            dependencies.add(targetId);
        }
      }
      return [sourceId, [...dependencies].sort()] as const;
    }),
  );
}

function topLevelCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim().split(/\s+/u)[0]!).filter(Boolean))].sort();
}

function documentedWorkflowNames(markdown: string): string[] {
  return [...markdown.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!);
}

describe("public registration contract", () => {
  it("declares the eleven supported active entrypoints", () => {
    expect(pkg.pi.extensions).toEqual([
      "./extensions/agents/index.ts",
      "./extensions/ask-user-question/index.ts",
      "./extensions/ast-structural-edit/index.ts",
      "./extensions/devext-doctor/index.ts",
      "./extensions/loop/index.ts",
      "./extensions/model/index.ts",
      "./extensions/plan/index.ts",
      "./extensions/security-gate/index.ts",
      "./extensions/status-line/index.ts",
      "./extensions/todo-context/index.ts",
      "./extensions/workflows/index.ts",
    ]);
    expect(pkg.files.some((file) => file.startsWith("extensions/beta/"))).toBe(false);
  });

  it("keeps runtime slash-command registration aligned with extension manifests", async () => {
    for (const entrypoint of pkg.pi.extensions) {
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
      const module = (await import(pathToFileURL(path.join(root, entrypoint)).href)) as { default: ExtensionFactory };
      const harness = createHarness();
      await module.default(harness.pi);
      expect([...harness.commands.keys()].sort(), `runtime commands differ from ${manifestPath}`).toEqual(
        topLevelCommands(manifest.provides.commands),
      );
    }
  });

  it("publishes one resolvable dedicated agent for every default extension", () => {
    const extensionIds = pkg.pi.extensions.map(extensionIdFromEntrypoint);
    const entries = loadExtensionAgentCatalog();
    expect(entries.map((entry) => entry.extensionId).sort()).toEqual([...extensionIds].sort());
    for (const entry of entries) {
      expect(pkg.files).toContain(entry.profilePath);
      expect(pkg.files).toContain(entry.manifestPath);
      expect(entry.description.length).toBeLessThanOrEqual(96);
    }
  });

  it("resolves exactly the workflows the packaged examples directory holds", () => {
    expect(packagedWorkflowNames()).toEqual([
      "implement",
      "live-smoke",
      "post-code-review",
      "post-code-review/boundaries",
      "post-code-review/contracts",
      "post-code-review/necessity",
      "post-code-review/scope",
      "post-code-review/simplicity",
      "post-code-review/style",
      "post-code-review/synthesis",
      "task/implement",
      "task/plan",
      "workflow-creator",
      "workflow-creator/build",
      "workflow-creator/design",
      "workflow-creator/svg",
    ]);
  });

  it("keeps the compact extension reference aligned with manifests and source imports", () => {
    const extensionIds = pkg.pi.extensions.map(extensionIdFromEntrypoint);
    const rows = parseExtensionRows(extensionDocs);
    expect([...rows.keys()].sort()).toEqual([...extensionIds].sort());
    for (const [index, entrypoint] of pkg.pi.extensions.entries()) {
      const id = extensionIds[index]!;
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
      expect(rows.get(id)).toEqual({
        tools: manifest.provides.tools,
        commands: manifest.provides.commands,
        hooks: manifest.provides.hooks,
        risk: manifest.risk,
        manual: manifest.docsPath,
      });
      expect(existsSync(path.join(root, manifest.docsPath)), manifest.docsPath).toBe(true);
      expect(pkg.files).toContain(manifest.docsPath);
      expect(manifest.sourceAuditPath).toBeNull();
      for (const testPath of manifest.tests)
        expect(existsSync(path.join(root, testPath)), `missing test from ${manifestPath}: ${testPath}`).toBe(true);
    }
    const sourceGraph = featureDependencyGraph(extensionIds);
    expect([...sourceGraph].filter(([, dependencies]) => dependencies.length > 0)).toEqual([
      ["agents", ["workflows"]],
      ["loop", ["workflows"]],
    ]);
    expect(extensionDocs).toContain("`agents → workflows`");
    expect(extensionDocs).toContain("`loop → workflows/run-read.ts`");
  });

  it("keeps all sixteen Package workflows in the public workflow guide", () => {
    expect(documentedWorkflowNames(workflowDocs).sort()).toEqual([...packagedWorkflowNames()].sort());
    expect(workflowDocs).toContain("`task` is a group-only namespace");
  });

  it("binds the MIT package to the clean repository identity", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/kroffske/locus-pi.git");
  });
});
