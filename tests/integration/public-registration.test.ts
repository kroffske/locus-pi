import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadExtensionAgentCatalog } from "../../extensions/agents/catalog.js";
import { packagedWorkflowNames } from "../../extensions/workflows/runtime/workflow-runner.js";

interface PackageJson {
  files: string[];
  license: string;
  pi: { extensions: string[] };
  repository: { url: string };
}

interface ExtensionManifest {
  docsPath: string;
  sourceAuditPath: string | null;
  tests: string[];
}

interface ExtensionMapRow {
  dependencies: string[];
  entrypoint: string;
  manifest: string;
  manual: string;
}

type ExtensionCatalogRow = ExtensionMapRow;

const sourceAuditUrlPrefix = "https://github.com/kroffske/locus-pi/blob/main/";
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
const extensionIndex = readFileSync(path.join(root, "docs/extension-index.md"), "utf8");
const extensionCatalog = readFileSync(path.join(root, "docs/extension-catalog.md"), "utf8");
const ownershipMatrix = readFileSync(path.join(root, "docs/extension-ownership-matrix.md"), "utf8");

function extensionIdFromEntrypoint(entrypoint: string): string {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/.exec(entrypoint);
  if (!match?.[1]) {
    throw new Error(`invalid default extension entrypoint: ${entrypoint}`);
  }
  return match[1];
}

function inlineCode(value: string): string {
  const match = /^`([^`]+)`$/.exec(value.trim());
  if (!match?.[1]) {
    throw new Error(`expected one inline-code value, received: ${value}`);
  }
  return match[1];
}

function parseExtensionMap(markdown: string): Map<string, ExtensionMapRow> {
  const defaultSection = markdown.split("## Default extensions\n")[1]?.split("\n## ")[0];
  if (!defaultSection) {
    throw new Error("missing Default extensions section");
  }

  const rows = new Map<string, ExtensionMapRow>();
  for (const line of defaultSection.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const columns = line
      .split("|")
      .slice(1, -1)
      .map((column) => column.trim());
    if (columns.length !== 10) {
      throw new Error(`invalid extension map row: ${line}`);
    }

    const id = inlineCode(columns[0] ?? "");
    if (rows.has(id)) {
      throw new Error(`duplicate extension map row: ${id}`);
    }
    const dependencyCell = columns[7] ?? "";
    rows.set(id, {
      entrypoint: inlineCode(columns[4] ?? ""),
      manifest: inlineCode(columns[5] ?? ""),
      manual: inlineCode(columns[6] ?? ""),
      dependencies:
        dependencyCell === "none" ? [] : [...dependencyCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
    });
  }
  return rows;
}

function parseExtensionCatalog(markdown: string): Map<string, ExtensionCatalogRow> {
  const section = markdown.split("## Public roster\n")[1]?.split("\n## ")[0];
  if (!section) {
    throw new Error("missing Public roster section");
  }

  const rows = new Map<string, ExtensionCatalogRow>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const columns = line
      .split("|")
      .slice(1, -1)
      .map((column) => column.trim());
    if (columns.length !== 8) {
      throw new Error(`invalid extension catalog row: ${line}`);
    }

    const id = inlineCode(columns[0] ?? "");
    if (rows.has(id)) {
      throw new Error(`duplicate extension catalog row: ${id}`);
    }
    const dependencyCell = columns[5] ?? "";
    rows.set(id, {
      entrypoint: inlineCode(columns[2] ?? ""),
      manifest: inlineCode(columns[3] ?? ""),
      manual: inlineCode(columns[4] ?? ""),
      dependencies:
        dependencyCell === "none"
          ? []
          : [...dependencyCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.split("/")[0]!),
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
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (node.arguments.length === 1 && argument && ts.isStringLiteral(argument)) {
        specifiers.push(argument.text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function featureDependencyGraph(extensionIds: string[]): Map<string, string[]> {
  return new Map(
    extensionIds.map((sourceId) => {
      const dependencies = new Set<string>();
      const directory = path.join(root, "extensions", sourceId);
      for (const filePath of sourceFiles(directory)) {
        for (const specifier of importedSpecifiers(filePath)) {
          if (!specifier.startsWith(".")) continue;
          const targetPath = path.relative(root, path.resolve(path.dirname(filePath), specifier));
          const [topLevel, targetId] = targetPath.split(path.sep);
          if (topLevel === "extensions" && targetId && targetId !== "_shared" && targetId !== sourceId) {
            dependencies.add(targetId);
          }
        }
      }
      return [sourceId, [...dependencies].sort()] as const;
    }),
  );
}

function documentedDependencyGraph(markdown: string): Map<string, string[]> {
  const section = markdown.split("## Direct feature dependency graph\n")[1]?.split("\n## ")[0];
  if (!section) {
    throw new Error("missing Direct feature dependency graph section");
  }

  const graph = new Map<string, string[]>();
  const bullets: string[] = [];
  let currentBullet = "";
  for (const line of section.split("\n")) {
    if (line.startsWith("- ")) {
      if (currentBullet) bullets.push(currentBullet);
      currentBullet = line;
    } else if (currentBullet && line.trim() === "") {
      bullets.push(currentBullet);
      currentBullet = "";
    } else if (currentBullet) {
      currentBullet += `\n${line}`;
    }
  }
  if (currentBullet) bullets.push(currentBullet);

  for (const bullet of bullets) {
    const edge = /`([^`]+) → ([^`/]+)(?:\/[^`]*)?`/.exec(bullet);
    if (edge?.[1] && edge[2]) {
      graph.set(edge[1], [edge[2]]);
    } else if (bullet.includes("no direct feature imports")) {
      for (const match of bullet.matchAll(/`([^`]+)`/g)) {
        graph.set(match[1]!, []);
      }
    }
  }
  return graph;
}

function packageWorkflowNamesFromIndex(markdown: string): string[] {
  const section = markdown.split("## Package workflows\n")[1]?.split("\n## ")[0] ?? "";
  return [...section.matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1]!);
}

describe("public registration contract", () => {
  it("declares the ten supported active entrypoints", () => {
    expect(pkg.pi.extensions).toEqual([
      "./extensions/agents/index.ts",
      "./extensions/ask-user-question/index.ts",
      "./extensions/ast-structural-edit/index.ts",
      "./extensions/devext-doctor/index.ts",
      "./extensions/loop/index.ts",
      "./extensions/model/index.ts",
      "./extensions/plan/index.ts",
      "./extensions/security-gate/index.ts",
      "./extensions/todo-context/index.ts",
      "./extensions/workflows/index.ts",
    ]);
    expect(pkg.files.some((file) => file.startsWith("extensions/beta/"))).toBe(false);
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
    // No allowlist backs this: the names come from scanning the shipped
    // directory, in entry-filename order.
    expect(packagedWorkflowNames()).toEqual([
      "live-smoke",
      "plan-implement",
      "plan",
      "requirements-grill",
      "review-fix",
      "review",
    ]);
  });

  it("keeps the public extension catalog aligned with package, manifests, manuals, and source imports", () => {
    const extensionIds = pkg.pi.extensions.map(extensionIdFromEntrypoint);
    const catalogRows = parseExtensionCatalog(extensionCatalog);
    expect([...catalogRows.keys()].sort()).toEqual([...extensionIds].sort());

    for (const [index, entrypoint] of pkg.pi.extensions.entries()) {
      const id = extensionIds[index]!;
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
      const catalogRow = catalogRows.get(id);

      expect(catalogRow, `missing extension catalog row: ${id}`).toBeDefined();
      expect(catalogRow?.entrypoint).toBe(entrypoint.slice(2));
      expect(catalogRow?.manifest).toBe(path.relative(root, manifestPath));
      expect(catalogRow?.manual).toBe(manifest.docsPath);
      expect(existsSync(path.join(root, entrypoint)), `missing entrypoint: ${entrypoint}`).toBe(true);
      expect(existsSync(manifestPath), `missing manifest: ${manifestPath}`).toBe(true);
      expect(existsSync(path.join(root, manifest.docsPath)), `missing docsPath from ${manifestPath}`).toBe(true);
    }

    const sourceGraph = featureDependencyGraph(extensionIds);
    const catalogGraph = new Map([...catalogRows].map(([id, row]) => [id, row.dependencies]));
    expect(catalogGraph).toEqual(sourceGraph);
    expect(extensionCatalog).toContain("`agents → workflows`");
    expect(extensionCatalog).toContain("`loop → workflows/run-read.ts`");
  });

  it("keeps the public extension map aligned with package, manifests, manuals, and source imports", () => {
    const extensionIds = pkg.pi.extensions.map(extensionIdFromEntrypoint);
    const mapRows = parseExtensionMap(extensionIndex);
    expect([...mapRows.keys()].sort()).toEqual([...extensionIds].sort());

    for (const [index, entrypoint] of pkg.pi.extensions.entries()) {
      const id = extensionIds[index]!;
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
      const mapRow = mapRows.get(id);

      expect(mapRow, `missing extension map row: ${id}`).toBeDefined();
      expect(mapRow?.entrypoint).toBe(entrypoint.slice(2));
      expect(mapRow?.manifest).toBe(path.relative(root, manifestPath));
      expect(mapRow?.manual).toBe(manifest.docsPath);
      expect(existsSync(path.join(root, entrypoint)), `missing entrypoint: ${entrypoint}`).toBe(true);
      expect(existsSync(manifestPath), `missing manifest: ${manifestPath}`).toBe(true);
      expect(existsSync(path.join(root, manifest.docsPath)), `missing docsPath from ${manifestPath}`).toBe(true);
      for (const testPath of manifest.tests) {
        expect(existsSync(path.join(root, testPath)), `missing test from ${manifestPath}: ${testPath}`).toBe(true);
      }

      if (manifest.sourceAuditPath !== null) {
        expect(manifest.sourceAuditPath.startsWith(sourceAuditUrlPrefix), manifestPath).toBe(true);
        const repositoryPath = manifest.sourceAuditPath.slice(sourceAuditUrlPrefix.length);
        expect(existsSync(path.join(root, repositoryPath)), `missing source audit from ${manifestPath}`).toBe(true);
      }
    }

    const sourceGraph = featureDependencyGraph(extensionIds);
    const columnGraph = new Map([...mapRows].map(([id, row]) => [id, row.dependencies]));
    const sectionGraph = documentedDependencyGraph(extensionIndex);
    expect(columnGraph).toEqual(sourceGraph);
    expect(sectionGraph).toEqual(sourceGraph);
    expect([...sourceGraph].filter(([, dependencies]) => dependencies.length > 0)).toEqual([
      ["agents", ["workflows"]],
      ["loop", ["workflows"]],
    ]);
    expect(extensionIndex).toContain("`loop → workflows/run-read.ts`");
  });

  it("keeps all six Package workflows aligned across the public index and ownership matrix", () => {
    const workflowNames = packagedWorkflowNames();
    expect(workflowNames).toHaveLength(6);
    expect(packageWorkflowNamesFromIndex(extensionIndex).sort()).toEqual([...workflowNames].sort());
    expect(ownershipMatrix).toContain("Only six Package workflow names");
    expect(ownershipMatrix).not.toContain("Only four Package names");
  });

  it("binds the MIT package to the clean repository identity", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/kroffske/locus-pi.git");
  });
});
