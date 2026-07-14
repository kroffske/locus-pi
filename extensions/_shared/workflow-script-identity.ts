import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";

export const WORKFLOW_SCRIPT_IDENTITY_SCHEMA_VERSION = 2 as const;
export const WORKFLOW_IDENTITY_POLICY = "static-node-only-v1" as const;

export type WorkflowIdentityCoverage =
  | "self-contained-static"
  | "entry-only"
  | "entry-only-legacy";

export type WorkflowExecutionSource = "snapshot" | "source";

/** Versioned source identity persisted privately in one workflow result. */
export interface WorkflowScriptIdentity {
  schemaVersion: typeof WORKFLOW_SCRIPT_IDENTITY_SCHEMA_VERSION;
  identityPolicy: typeof WORKFLOW_IDENTITY_POLICY;
  sourcePath: string;
  snapshotPath: string;
  scriptSha256: string;
  identityCoverage: Exclude<WorkflowIdentityCoverage, "entry-only-legacy">;
  executionSource: WorkflowExecutionSource;
  nodeVersion: string;
  platform: string;
  arch: string;
  builtinImports: string[];
  unboundDependencies: string[];
}

export interface WorkflowSourceIdentityAssessment {
  identityCoverage: WorkflowScriptIdentity["identityCoverage"];
  builtinImports: string[];
  unboundDependencies: string[];
}

/**
 * Inspect exact entry bytes before evaluation.
 *
 * The default policy proves only that the declared module graph is static and
 * Node-builtin-only. It is deliberately not a sandbox or determinism claim.
 * Reviewed modular scripts can opt down to entry-only evidence through one
 * literal, hash-bound meta field.
 */
export function assessWorkflowSourceIdentity(source: string): WorkflowSourceIdentityAssessment {
  let root: SgNode;
  try {
    root = parse(Lang.JavaScript, source).root();
  } catch (error) {
    throw new Error(`Workflow source parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parseErrors = root.findAll({ rule: { kind: "ERROR" } });
  if (parseErrors.length > 0) {
    throw new Error(`Workflow source parse failed: ${oneLine(parseErrors[0]!.text())}`);
  }

  const declaredCoverage = readDeclaredIdentityCoverage(root);
  const builtinImports = new Set<string>();
  const unboundDependencies = new Set<string>();

  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    recordStaticDependency("import", specifier, builtinImports, unboundDependencies);
  }

  for (const statement of root.findAll({ rule: { kind: "export_statement" } })) {
    if (!statement.children().some((child) => child.kind() === "from")) continue;
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    recordStaticDependency("re-export", specifier, builtinImports, unboundDependencies);
  }

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapParenthesizedCallee(call.children().find((child) => child.kind() !== "comment"));
    if (callee?.kind() === "import") {
      unboundDependencies.add(`dynamic-import:${callArgumentLabel(call)}`);
    } else if (callee?.kind() === "identifier" && callee.text() === "require") {
      unboundDependencies.add(`require:${callArgumentLabel(call)}`);
    }
  }

  for (const meta of root.findAll({ rule: { kind: "meta_property" } })) {
    if (meta.text().replace(/\s+/gu, "") === "import.meta") unboundDependencies.add("import.meta");
  }

  const sortedBuiltins = [...builtinImports].sort();
  const sortedUnbound = [...unboundDependencies].sort();
  if (declaredCoverage !== "entry-only" && sortedUnbound.length > 0) {
    const preview = sortedUnbound.slice(0, 3).join(", ");
    const suffix = sortedUnbound.length > 3 ? ` (+${sortedUnbound.length - 3} more)` : "";
    throw new Error(
      "Workflow source has dependencies outside self-contained-static identity: "
      + `${preview}${suffix}. Add literal meta.identityCoverage = \"entry-only\" to acknowledge unbound dependencies.`,
    );
  }

  return {
    identityCoverage: declaredCoverage ?? "self-contained-static",
    builtinImports: sortedBuiltins,
    unboundDependencies: sortedUnbound,
  };
}

export function createWorkflowScriptSnapshot(sourcePath: string, runDir: string): WorkflowScriptIdentity {
  const sourceBytes = readFileSync(sourcePath);
  const assessment = assessWorkflowSourceIdentity(sourceBytes.toString("utf8"));
  const scriptSha256 = sha256WorkflowBytes(sourceBytes);
  const snapshotPath = path.join(runDir, `script-${scriptSha256}.workflow.mjs`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(snapshotPath, sourceBytes, { flag: "wx" });
  chmodSync(snapshotPath, 0o444);

  const identity: WorkflowScriptIdentity = {
    schemaVersion: WORKFLOW_SCRIPT_IDENTITY_SCHEMA_VERSION,
    identityPolicy: WORKFLOW_IDENTITY_POLICY,
    sourcePath,
    snapshotPath,
    scriptSha256,
    identityCoverage: assessment.identityCoverage,
    executionSource: assessment.identityCoverage === "self-contained-static" ? "snapshot" : "source",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    builtinImports: assessment.builtinImports,
    unboundDependencies: assessment.unboundDependencies,
  };
  verifyWorkflowScriptSnapshot(identity);
  return identity;
}

export function workflowScriptExecutionPath(identity: WorkflowScriptIdentity): string {
  return identity.executionSource === "snapshot" ? identity.snapshotPath : identity.sourcePath;
}

export function verifyWorkflowScriptSnapshot(identity: Pick<WorkflowScriptIdentity, "snapshotPath" | "scriptSha256">): void {
  const snapshotSha256 = sha256WorkflowBytes(readFileSync(identity.snapshotPath));
  if (snapshotSha256 !== identity.scriptSha256) {
    throw new Error(`Workflow script snapshot hash mismatch: expected ${identity.scriptSha256}, got ${snapshotSha256}`);
  }
}

export function sha256WorkflowBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readDeclaredIdentityCoverage(root: SgNode): WorkflowScriptIdentity["identityCoverage"] | undefined {
  const values: Array<SgNode | null> = [];
  for (const statement of root.findAll("export const meta = $META")) {
    const meta = exportedMetaObject(statement);
    if (meta === undefined) continue;
    for (const pair of meta.children()) {
      if (pair.kind() !== "pair" || staticObjectKey(pair.field("key")) !== "identityCoverage") continue;
      values.push(pair.field("value"));
    }
  }
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("Workflow meta.identityCoverage must be declared exactly once");
  const value = staticStringValue(values[0]);
  if (value !== "self-contained-static" && value !== "entry-only") {
    throw new Error('Workflow meta.identityCoverage must be the literal "self-contained-static" or "entry-only"');
  }
  return value;
}

function recordStaticDependency(
  kind: "import" | "re-export",
  specifier: string | undefined,
  builtinImports: Set<string>,
  unboundDependencies: Set<string>,
): void {
  if (specifier?.startsWith("node:") === true) {
    builtinImports.add(specifier);
    return;
  }
  unboundDependencies.add(`${kind}:${boundedLabel(specifier ?? "<non-literal>")}`);
}

function unwrapParenthesizedCallee(node: SgNode | undefined): SgNode | undefined {
  let current = node;
  while (current?.kind() === "parenthesized_expression") {
    current = current.children().find((child) =>
      child.kind() !== "(" && child.kind() !== ")" && child.kind() !== "comment"
    );
  }
  return current;
}

function callArgumentLabel(call: SgNode): string {
  const args = call.children().find((child) => child.kind() === "arguments");
  const literal = staticStringValue(args?.children().find((child) => child.kind() === "string"));
  return boundedLabel(literal ?? "<dynamic>");
}

function exportedMetaObject(statement: SgNode): SgNode | undefined {
  const declaration = statement.children().find((child) => child.kind() === "lexical_declaration");
  const variable = declaration?.children().find((child) =>
    child.kind() === "variable_declarator" && child.field("name")?.text() === "meta"
  );
  const value = variable?.field("value");
  return value?.kind() === "object" ? value : undefined;
}

function staticObjectKey(node: SgNode | null | undefined): string | undefined {
  if (node == null || node.kind() === "computed_property_name") return undefined;
  if (node.kind() === "string") return staticStringValue(node);
  return node.text();
}

function staticStringValue(node: SgNode | null | undefined): string | undefined {
  if (node == null || (node.kind() !== "string" && node.kind() !== "template_string")) return undefined;
  let value = "";
  for (const child of node.children()) {
    if (child.kind() === "string_fragment") value += child.text();
    else if (child.kind() === "escape_sequence") value += decodeEscapeSequence(child.text());
    else if (child.kind() === "template_substitution") return undefined;
  }
  return value;
}

function decodeEscapeSequence(value: string): string {
  const body = value.slice(1);
  const fixed: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
  if (fixed[body] !== undefined) return fixed[body];
  const unicodeCodePoint = /^u\{([0-9a-f]+)\}$/iu.exec(body)?.[1];
  if (unicodeCodePoint !== undefined) return String.fromCodePoint(Number.parseInt(unicodeCodePoint, 16));
  const unicode = /^u([0-9a-f]{4})$/iu.exec(body)?.[1];
  if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
  const hex = /^x([0-9a-f]{2})$/iu.exec(body)?.[1];
  if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
  if (body === "\n" || body === "\r\n") return "";
  return body;
}

function boundedLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 256);
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 160);
}
