import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface PackageJson {
  files: string[];
  license: string;
  pi: { extensions: string[] };
  repository: { url: string };
}

export interface ExtensionManifest {
  docsPath: string;
  provides: { tools: string[]; commands: string[]; hooks: string[]; shortcuts?: string[] };
  risk: string;
  sourceAuditPath: string | null;
  tests: string[];
}

export interface ExtensionDocRow {
  tools: string[];
  commands: string[];
  hooks: string[];
  risk: string;
  manual: string;
}

export const root = process.cwd();
export const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
export const extensionDocs = readFileSync(path.join(root, "docs/extensions.md"), "utf8");
export const workflowDocs = readFileSync(path.join(root, "docs/workflows.md"), "utf8");
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

export function extensionIdFromEntrypoint(entrypoint: string): string {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/u.exec(entrypoint);
  if (!match?.[1]) throw new Error(`invalid default extension entrypoint: ${entrypoint}`);
  return match[1];
}

export function inlineCodeList(value: string): string[] {
  if (value === "—") return [];
  const items = [...value.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
  if (items.length === 0) throw new Error(`expected inline-code list or em dash, received: ${value}`);
  return items;
}

export function parseExtensionRows(markdown: string): Map<string, ExtensionDocRow> {
  const rows = new Map<string, ExtensionDocRow>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const columns = line
      .split("|")
      .slice(1, -1)
      .map((column) => column.trim());
    if (columns.length !== 6) throw new Error(`invalid extension reference row: ${line}`);
    const id = /^`([^`]+)`$/u.exec(columns[0] ?? "")?.[1];
    const manual = /\[`([^`]+)`\]\([^)]+\)/u.exec(columns[5] ?? "")?.[1];
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

export function featureDependencyGraph(extensionIds: string[]): Map<string, string[]> {
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

export function topLevelCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim().split(/\s+/u)[0]!).filter(Boolean))].sort();
}

export function documentedWorkflowNames(markdown: string): string[] {
  return [...markdown.matchAll(/^\| `([^`]+)`\s+\|/gmu)].map((match) => match[1]!);
}
