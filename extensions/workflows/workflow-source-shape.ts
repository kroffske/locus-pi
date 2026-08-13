import { Lang, parse, type SgNode } from "@ast-grep/napi";

/**
 * Static authoring-profile gate. This protects the readable standard grammar;
 * it is not a runtime domain linter and does not inspect model output.
 */
export function standardWorkflowSourceShapeErrors(source: string): string[] {
  const errors = new Set<string>();
  let root: SgNode;
  try {
    root = parse(Lang.JavaScript, source).root();
  } catch (error) {
    return [`source parse failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const parseError = root.findAll({ rule: { kind: "ERROR" } })[0];
  if (parseError !== undefined) return [`source parse failed: ${oneLineSourceShape(parseError.text())}`];

  const runEntry = validateStandardTopLevel(root, errors);
  validateStandardStatements(runEntry, errors);
  validateStandardDependencies(root, errors);
  validateStandardOwnedPolicy(root, runEntry, errors);
  validateStandardIdentifierRoots(root, errors);
  const dslBindings = standardDslBindings(runEntry);
  const bindingModel = standardBindingModel(root, runEntry, dslBindings, errors);
  const protectedBindings = new Set([...dslBindings, ...bindingModel.collections.names, "Error"]);
  validateStandardExpressions(root, protectedBindings, dslBindings, bindingModel, errors);
  validateStandardCalls(root, runEntry, dslBindings, bindingModel.collections, errors);
  validateStandardValueUses(root, runEntry, dslBindings, bindingModel, errors);
  return [...errors].sort();
}

const STANDARD_RUN_NAMES = new Set(["run", "runWorkflow"]);
const STANDARD_EDGE_METHODS = new Set(["agent", "invokeWorkflow"]);
const STANDARD_INLINE_EDGE_OWNERS = new Set(["parallel", "pipeline", "workflow"]);
const STANDARD_DSL_METHOD_NAMES = [
  "agent",
  "awaitOperator",
  "consumeTextArtifact",
  "continuationArtifacts",
  "invokeWorkflow",
  "items",
  "log",
  "now",
  "outputDir",
  "parallel",
  "phase",
  "pipeline",
  "projectRoot",
  "promptFile",
  "publishArtifact",
  "publishPrimaryArtifact",
  "publishPrimaryFile",
  "random",
  "workflow",
  "workspace",
] as const;
type StandardDslMethod = (typeof STANDARD_DSL_METHOD_NAMES)[number];
const STANDARD_DSL_METHODS: ReadonlySet<string> = new Set(STANDARD_DSL_METHOD_NAMES);
const STANDARD_PUBLISHED_ARTIFACT_METHODS: ReadonlySet<StandardDslMethod> = new Set([
  "publishArtifact",
  "publishPrimaryArtifact",
  "publishPrimaryFile",
]);
const STANDARD_COLLECTION_DSL_METHODS = new Set(["agent", "continuationArtifacts", "items", "parallel", "pipeline"]);
const STANDARD_STATEMENTS = new Set([
  "break_statement",
  "continue_statement",
  "empty_statement",
  "expression_statement",
  "for_in_statement",
  "for_statement",
  "if_statement",
  "lexical_declaration",
  "return_statement",
  "switch_statement",
  "throw_statement",
  "while_statement",
]);

/** Validate the closed standard module surface and return its one visible run function. */
function validateStandardTopLevel(root: SgNode, errors: Set<string>): SgNode | undefined {
  let metaCount = 0;
  const runEntries: SgNode[] = [];
  for (const statement of root.children()) {
    if (statement.kind() === "comment" || statement.kind() === "hash_bang_line" || statement.kind() === ";") continue;
    if (statement.kind() === "lexical_declaration") {
      if (!isLiteralConstDeclaration(statement)) {
        errors.add("standard profile top-level constants must contain only literal data");
      }
      continue;
    }
    if (statement.kind() !== "export_statement") {
      errors.add("standard profile top level permits only literal constants, literal meta, and one default run export");
      continue;
    }

    const meta = exportedMetaObject(statement);
    if (meta !== undefined) {
      metaCount += 1;
      if (!isExactLiteralMetaExport(statement, meta) || staticMetaProfile(meta) !== "standard") {
        errors.add('standard profile requires one literal `export const meta` with `profile: "standard"`');
      }
      continue;
    }

    const entry = statement
      .children()
      .find(
        (child) =>
          child.kind() === "function_declaration" ||
          child.kind() === "function_expression" ||
          child.kind() === "arrow_function",
      );
    if (statement.children().some((child) => child.kind() === "default") && entry !== undefined) {
      const name = entry.field("name")?.text();
      if (name !== undefined && !STANDARD_RUN_NAMES.has(name)) {
        errors.add("standard profile run export is named run or runWorkflow");
      }
      runEntries.push(entry);
      continue;
    }

    errors.add("standard profile exports only literal meta and one visible default run function");
  }
  if (metaCount !== 1)
    errors.add('standard profile requires one literal `export const meta` with `profile: "standard"`');
  if (runEntries.length !== 1) errors.add("standard profile requires exactly one visible default run function");
  return runEntries.length === 1 ? runEntries[0] : undefined;
}

/** Standard orchestration uses ordinary declarations/control flow, never hidden statement machinery. */
function validateStandardStatements(runEntry: SgNode | undefined, errors: Set<string>): void {
  if (runEntry === undefined) return;
  for (const block of runEntry.findAll({ rule: { kind: "statement_block" } })) {
    for (const statement of block.children()) {
      if (isStructuralStatementNode(statement)) continue;
      if (!STANDARD_STATEMENTS.has(String(statement.kind()))) {
        errors.add(`standard profile does not permit ${statement.kind()} in the run body`);
      }
    }
  }
}

function validateStandardDependencies(root: SgNode, errors: Set<string>): void {
  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    errors.add(
      specifier?.startsWith("node:") === true
        ? "standard profile imports no node: modules"
        : "standard profile imports no modules",
    );
  }
  for (const statement of root.findAll({ rule: { kind: "export_statement" } })) {
    if (!statement.children().some((child) => child.kind() === "from")) continue;
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    errors.add(
      specifier?.startsWith("node:") === true
        ? "standard profile re-exports no node: modules"
        : "standard profile re-exports no modules",
    );
  }
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee?.kind() === "import") {
      errors.add("standard profile uses no dynamic imports");
    } else if (callee?.kind() === "identifier" && callee.text() === "require") {
      errors.add("standard profile uses no require() imports");
    }
  }
}

function validateStandardOwnedPolicy(root: SgNode, runEntry: SgNode | undefined, errors: Set<string>): void {
  if (root.findAll({ rule: { kind: "try_statement" } }).length > 0) {
    errors.add("standard profile owns no try/catch recovery");
  }
  if (root.findAll({ rule: { kind: "class_declaration" } }).length > 0) {
    errors.add("standard profile owns no class helpers");
  }
  for (const pair of root.findAll({ rule: { kind: "pair" } })) {
    const key = staticObjectKey(pair.field("key"));
    if (key === "schema" || key === "validate") errors.add(`standard profile owns no raw ${key}`);
  }
  if (root.findAll({ rule: { kind: "computed_property_name" } }).length > 0) {
    errors.add("standard profile uses no computed object keys that hide policy");
  }
  if (root.findAll({ rule: { kind: "regex" } }).length > 0) {
    errors.add("standard profile owns no regex gates");
  }
  for (const declaration of root.findAll({ rule: { kind: "function_declaration" } })) {
    if (declaration.id() === runEntry?.id()) continue;
    const name = declaration.field("name")?.text() ?? "anonymous";
    errors.add(`standard profile keeps no nested or top-level helper function ${name}`);
  }
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const name = declaration.field("name")?.text() ?? "";
    const value = declaration.field("value");
    if (value?.kind() === "arrow_function" || value?.kind() === "function_expression") {
      errors.add(`standard profile keeps no function-valued helper ${name || "binding"}`);
    }
  }
  for (const callback of [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ]) {
    if (callback.id() === runEntry?.id()) continue;
    if (callback.kind() === "function_expression") {
      errors.add("standard profile uses arrow functions for inline callbacks");
    }
    const owner = callback.parent();
    if (owner?.kind() === "pair" || owner?.kind() === "variable_declarator") {
      errors.add("standard profile keeps no object or variable function wrapper");
    } else if (containsStandardEdgeCall(callback) && !isVisibleInlineEdgeCallback(callback)) {
      errors.add("standard profile keeps inline agent edges only inside visible parallel, pipeline, or workflow calls");
    }
  }
  for (const method of root.findAll({ rule: { kind: "method_definition" } })) {
    errors.add(`standard profile keeps no object/class method helper ${method.field("name")?.text() ?? "method"}`);
  }
}

interface StandardLexicalBinding {
  name: string;
  scopeId: number;
}

function validateStandardIdentifierRoots(root: SgNode, errors: Set<string>): void {
  const bindings = standardLexicalBindings(root);
  const approvedGlobals = new Set(["Error"]);
  if (
    root.findAll({ rule: { kind: "this" } }).length > 0 ||
    root.findAll({ rule: { kind: "meta_property" } }).length > 0
  ) {
    errors.add("standard profile reads values only from declared lexical bindings and approved language roots");
  }
  for (const identifier of [
    ...root.findAll({ rule: { kind: "identifier" } }),
    ...root.findAll({ rule: { kind: "shorthand_property_identifier" } }),
  ]) {
    if (identifier.text() === "arguments") {
      errors.add("standard profile does not use the implicit arguments object");
      continue;
    }
    if (approvedGlobals.has(identifier.text())) continue;
    const ancestorIds = new Set(identifier.ancestors().map((ancestor) => ancestor.id()));
    if (
      bindings.some(
        (binding) =>
          binding.name === identifier.text() && (binding.scopeId === root.id() || ancestorIds.has(binding.scopeId)),
      )
    ) {
      continue;
    }
    errors.add("standard profile reads values only from declared lexical bindings and approved language roots");
  }
}

function standardLexicalBindings(root: SgNode): StandardLexicalBinding[] {
  const bindings: StandardLexicalBinding[] = [];
  const add = (names: readonly string[], scope: SgNode): void => {
    for (const name of names) bindings.push({ name, scopeId: scope.id() });
  };

  for (const callable of [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_declaration" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ]) {
    add(boundStandardNames(standardFunctionParameters(callable)), callable);
    const name = callable.field("name")?.text();
    if (name === undefined) continue;
    add([name], callable.kind() === "function_expression" ? callable : standardLexicalOwner(callable, root));
  }

  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    add(boundStandardNames(declaration.field("name") ?? undefined), standardLexicalOwner(declaration, root));
  }
  for (const loop of root.findAll({ rule: { kind: "for_in_statement" } })) {
    add(standardLoopBindingNames(loop.field("left") ?? undefined), loop);
  }
  return bindings;
}

function standardLexicalOwner(node: SgNode, root: SgNode): SgNode {
  const loop = node.ancestors().find((ancestor) => {
    if (ancestor.kind() === "for_statement") {
      return nodeWithinStandardNode(node, ancestor.field("initializer") ?? undefined);
    }
    if (ancestor.kind() === "for_in_statement") {
      return nodeWithinStandardNode(node, ancestor.field("left") ?? undefined);
    }
    return false;
  });
  if (loop !== undefined) return loop;
  return (
    node.ancestors().find((ancestor) => ancestor.kind() === "statement_block" || ancestor.kind() === "switch_body") ??
    root
  );
}

function validateStandardExpressions(
  root: SgNode,
  protectedBindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
  bindingModel: StandardBindingModel,
  errors: Set<string>,
): void {
  if (root.findAll({ rule: { kind: "sequence_expression" } }).length > 0) {
    errors.add("standard profile uses no sequence expressions");
  }
  for (const expression of [
    ...root.findAll({ rule: { kind: "assignment_expression" } }),
    ...root.findAll({ rule: { kind: "augmented_assignment_expression" } }),
    ...root.findAll({ rule: { kind: "update_expression" } }),
  ]) {
    if (!isOwnedForLoopCounterMutation(expression, protectedBindings)) {
      errors.add("standard profile does not mutate semantic values or build parser/renderer accumulators");
    }
  }
  for (const expression of root.findAll({ rule: { kind: "new_expression" } })) {
    if (unwrapStandardParentheses(expression.field("constructor") ?? undefined)?.text() !== "Error") {
      errors.add("standard profile constructs no helper, parser, renderer, or ledger objects");
      continue;
    }
    if (
      containsNonAuthorKnownValue(
        expression.field("arguments") ?? undefined,
        bindingModel.provenance,
        dslBindings,
        bindingModel.literalShadows,
      )
    ) {
      errors.add("standard profile constructs Error only from author-known or literal values");
    }
  }
}

function isOwnedForLoopCounterMutation(expression: SgNode, protectedBindings: ReadonlySet<string>): boolean {
  if (expression.kind() === "assignment_expression") return false;
  const loop = expression.ancestors().find((ancestor) => ancestor.kind() === "for_statement");
  if (loop?.field("increment")?.id() !== expression.id()) return false;
  const target = expression.field("left") ?? expression.field("argument");
  if (target?.kind() !== "identifier" || protectedBindings.has(target.text())) return false;
  const initializer = loop.field("initializer");
  if (initializer?.kind() !== "lexical_declaration") return false;
  const counterDeclaration = initializer
    .children()
    .filter((child) => child.kind() === "variable_declarator")
    .find(
      (declaration) =>
        declaration.field("name")?.kind() === "identifier" && declaration.field("name")?.text() === target.text(),
    );
  if (counterDeclaration?.field("value")?.kind() !== "number") return false;
  if (expression.kind() === "update_expression") return true;
  return (
    expression.kind() === "augmented_assignment_expression" &&
    ["+=", "-="].includes(expression.field("operator")?.text() ?? "") &&
    expression.field("right")?.kind() === "number"
  );
}

function validateStandardCalls(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  collectionBindings: StandardCollectionBindings,
  errors: Set<string>,
): void {
  validateStandardBindingShadows(root, runEntry, dslBindings, collectionBindings, errors);
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee == null || callee.kind() === "import") continue;
    if (callee.kind() === "subscript_expression") {
      errors.add("standard profile uses no computed calls that can hide orchestration or semantic transforms");
      continue;
    }
    const directDsl = directStandardDslCall(callee, dslBindings);
    if (
      directDsl === undefined &&
      !isVisibleCollectionCall(call, collectionBindings.names, dslBindings) &&
      !isBoundaryInputNormalization(call)
    ) {
      errors.add("standard profile calls only direct DSL primitives and visible map/prompt-join operations");
    }
  }
}

function standardDslBindings(runEntry: SgNode | undefined): Set<string> {
  const bindings = new Set<string>();
  if (runEntry === undefined) return bindings;
  const parameters = standardFunctionParameters(runEntry);
  const firstParameter = standardFunctionParameterNodes(parameters)[0];
  if (firstParameter?.kind() === "identifier" && firstParameter.text() === "dsl") {
    bindings.add("dsl");
  }
  if (firstParameter?.kind() === "object_pattern") addStandardDslBindings(bindings, firstParameter);
  for (const declaration of runEntry.findAll({ rule: { kind: "variable_declarator" } })) {
    if (
      !bindings.has("dsl") ||
      declaration.field("value")?.text() !== "dsl" ||
      declaration.field("name")?.kind() !== "object_pattern"
    )
      continue;
    addStandardDslBindings(bindings, declaration.field("name")!);
  }
  return bindings;
}

function addStandardDslBindings(bindings: Set<string>, pattern: SgNode): void {
  for (const child of pattern.children()) {
    if (child.kind() === "shorthand_property_identifier_pattern" && STANDARD_DSL_METHODS.has(child.text())) {
      bindings.add(child.text());
    } else if (child.kind() === "pair_pattern") {
      const key = staticObjectKey(child.field("key"));
      const value = child.field("value")?.text();
      if (key !== undefined && key === value && STANDARD_DSL_METHODS.has(key)) bindings.add(key);
    }
  }
}

function directStandardDslCall(callee: SgNode, bindings: ReadonlySet<string>): StandardDslMethod | undefined {
  if (callee.kind() === "identifier") {
    return bindings.has(callee.text()) && STANDARD_DSL_METHODS.has(callee.text())
      ? (callee.text() as StandardDslMethod)
      : undefined;
  }
  if (!bindings.has("dsl") || callee.kind() !== "member_expression" || callee.field("object")?.text() !== "dsl") {
    return undefined;
  }
  const property = callee.field("property")?.text();
  return property !== undefined && STANDARD_DSL_METHODS.has(property) ? (property as StandardDslMethod) : undefined;
}

interface StandardCollectionBindings {
  names: Set<string>;
  ownerIds: Set<number>;
  owners: Map<string, number>;
}

function standardCollectionBindings(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
): StandardCollectionBindings {
  const names = new Set<string>();
  const ownerIds = new Set<number>();
  const owners = new Map<string, number>();
  const body = runEntry?.children().find((child) => child.kind() === "statement_block");
  const bodyDeclarations =
    body
      ?.children()
      .flatMap((statement) =>
        statement.kind() === "lexical_declaration"
          ? statement.children().filter((child) => child.kind() === "variable_declarator")
          : [],
      ) ?? [];
  const moduleDeclarations = root
    .children()
    .flatMap((statement) =>
      statement.kind() === "lexical_declaration"
        ? statement.children().filter((child) => child.kind() === "variable_declarator")
        : [],
    );
  const declarations = [...moduleDeclarations, ...bodyDeclarations];
  for (const declaration of declarations) {
    const name = declaration.field("name");
    if (name?.kind() !== "identifier" || names.has(name.text())) continue;
    if (isStandardCollectionExpression(declaration.field("value") ?? undefined, names, dslBindings)) {
      names.add(name.text());
      ownerIds.add(declaration.id());
      owners.set(name.text(), declaration.id());
    }
  }
  return { names, ownerIds, owners };
}

function validateStandardBindingShadows(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  collectionBindings: StandardCollectionBindings,
  errors: Set<string>,
): void {
  if (runEntry === undefined) return;
  const protectedNames = new Set([...dslBindings, ...collectionBindings.names, "Error"]);
  const runParameters = standardFunctionParameters(runEntry);
  for (const name of boundStandardNames(runParameters)) {
    if (name === "Error") errors.add("standard profile does not shadow the global Error constructor");
  }

  for (const callback of [
    ...runEntry.findAll({ rule: { kind: "arrow_function" } }),
    ...runEntry.findAll({ rule: { kind: "function_expression" } }),
    ...runEntry.findAll({ rule: { kind: "function_declaration" } }),
  ]) {
    if (callback.id() === runEntry.id()) continue;
    const parameters = standardFunctionParameters(callback);
    if (boundStandardNames(parameters).some((name) => protectedNames.has(name))) {
      errors.add("standard profile nested callbacks do not shadow trusted DSL or collection bindings");
    }
  }

  const runBody = runEntry.children().find((child) => child.kind() === "statement_block");
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const names = boundStandardNames(declaration.field("name") ?? undefined);
    if (!names.some((name) => protectedNames.has(name))) continue;
    const ownerBlock = declaration.ancestors().find((ancestor) => ancestor.kind() === "statement_block");
    const trustedDslDestructure =
      ownerBlock?.id() === runBody?.id() &&
      dslBindings.has("dsl") &&
      declaration.field("value")?.text() === "dsl" &&
      declaration.field("name")?.kind() === "object_pattern" &&
      names.length > 0 &&
      names.every((name) => name !== "dsl" && dslBindings.has(name) && STANDARD_DSL_METHODS.has(name));
    const trustedCollection =
      collectionBindings.ownerIds.has(declaration.id()) &&
      names.every((name) => name !== "Error" && !dslBindings.has(name));
    if (!trustedDslDestructure && !trustedCollection) {
      errors.add("standard profile loop, switch, and nested bindings do not shadow trusted names");
    }
  }
  for (const loop of runEntry.findAll({ rule: { kind: "for_in_statement" } })) {
    if (boundStandardNames(loop.field("left") ?? undefined).some((name) => protectedNames.has(name))) {
      errors.add("standard profile loop bindings do not shadow trusted DSL, collection, or Error names");
    }
  }
}

function boundStandardNames(pattern: SgNode | undefined): string[] {
  if (pattern === undefined) return [];
  if (pattern.kind() === "identifier" || pattern.kind() === "shorthand_property_identifier_pattern") {
    return [pattern.text()];
  }
  if (pattern.kind() === "pair_pattern") {
    return boundStandardNames(pattern.field("value") ?? undefined);
  }
  const names: string[] = [];
  for (const child of pattern.children()) {
    if (
      child.kind() === "property_identifier" ||
      child.kind() === "shorthand_property_identifier" ||
      child.kind() === "comment"
    ) {
      continue;
    }
    names.push(...boundStandardNames(child));
  }
  return names;
}

/** Tree-sitter exposes a bare arrow parameter separately from parenthesized parameters. */
function standardFunctionParameters(callable: SgNode): SgNode | undefined {
  return callable.field("parameters") ?? callable.field("parameter") ?? undefined;
}

function standardFunctionParameterNodes(parameters: SgNode | undefined): SgNode[] {
  if (parameters === undefined) return [];
  if (parameters.kind() !== "formal_parameters") return [parameters];
  return parameters
    .children()
    .filter((child) =>
      ["array_pattern", "assignment_pattern", "identifier", "object_pattern", "rest_pattern"].includes(
        String(child.kind()),
      ),
    );
}

type StandardValueKind =
  | "known-collection"
  | "known-value"
  | "map-item"
  | "opaque-list"
  | "opaque-value"
  | "runtime-control"
  | "runtime-status"
  | "runtime-value"
  | "unclassified-dsl-value"
  | "void-value";

interface StandardValueProvenance {
  kind: StandardValueKind;
  sourceMethod?: StandardDslMethod;
}

type StandardDslReturnCategory =
  "agent-dependent" | "opaque-list" | "opaque-value" | "runtime-status" | "runtime-value" | "void-value";

const STANDARD_DSL_RETURN_CATEGORIES = {
  agent: "agent-dependent",
  awaitOperator: "void-value",
  consumeTextArtifact: "opaque-value",
  continuationArtifacts: "opaque-list",
  invokeWorkflow: "runtime-status",
  items: "opaque-list",
  log: "void-value",
  now: "runtime-value",
  outputDir: "runtime-value",
  parallel: "opaque-list",
  phase: "void-value",
  pipeline: "opaque-list",
  projectRoot: "runtime-value",
  promptFile: "opaque-value",
  publishArtifact: "runtime-value",
  publishPrimaryArtifact: "runtime-value",
  publishPrimaryFile: "runtime-value",
  random: "runtime-value",
  workflow: "opaque-value",
  workspace: "opaque-value",
} as const satisfies Record<StandardDslMethod, StandardDslReturnCategory>;

interface StandardLiteralShadow {
  name: string;
  scopeId: number;
}

interface StandardBindingModel {
  collections: StandardCollectionBindings;
  literalShadows: StandardLiteralShadow[];
  provenance: Map<string, StandardValueProvenance>;
}

function standardBindingModel(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  errors: Set<string>,
): StandardBindingModel {
  const collections = standardCollectionBindings(root, runEntry, dslBindings);
  if (runEntry === undefined) return { collections, literalShadows: [], provenance: new Map() };
  const values = standardValueProvenance(root, runEntry, dslBindings, collections, errors);
  return { collections, ...values };
}

function validateStandardValueUses(
  root: SgNode,
  runEntry: SgNode | undefined,
  dslBindings: ReadonlySet<string>,
  bindingModel: StandardBindingModel,
  errors: Set<string>,
): void {
  if (runEntry === undefined) return;
  const { literalShadows, provenance } = bindingModel;

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined) continue;
    const method = directStandardDslCall(callee, dslBindings);
    if (method === undefined) continue;
    const value = standardDslCallProvenance(method, call);
    if (value.kind === "unclassified-dsl-value") {
      errors.add("standard profile rejects DSL calls without an explicit return classification");
    } else if (value.kind === "void-value" && !isDiscardedStandardCall(call)) {
      errors.add("standard profile does not use void DSL calls as values");
    }
  }

  for (const access of [
    ...root.findAll({ rule: { kind: "member_expression" } }),
    ...root.findAll({ rule: { kind: "subscript_expression" } }),
  ]) {
    if (
      access.kind() === "subscript_expression" &&
      containsOpaqueIndexValue(access.field("index") ?? undefined, provenance, dslBindings, literalShadows)
    ) {
      errors.add("standard profile does not select a subscript with opaque semantic or model-produced values");
    }
    const owner = standardExpressionProvenance(
      access.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (owner === undefined) continue;
    if (
      owner.kind === "opaque-value" ||
      owner.kind === "map-item" ||
      owner.kind === "runtime-value" ||
      owner.kind === "void-value" ||
      owner.kind === "unclassified-dsl-value"
    ) {
      if (!isInsideBoundaryInputDefault(access)) {
        errors.add(
          "standard profile does not inspect properties of opaque semantic, model, file, host, or runtime values",
        );
      }
      continue;
    }
    if (owner.kind === "runtime-status") {
      if (access.kind() === "member_expression" && access.field("property")?.text() === "status") continue;
      errors.add("standard profile reads only the exact status identity from a runtime-owned result");
      continue;
    }
    if (owner.kind === "runtime-control") {
      errors.add("standard profile uses runtime-owned control values only by exact identity");
      continue;
    }
    if (access.kind() === "subscript_expression") continue;
    const property = access.field("property")?.text();
    if (property === "length" || property === "map") continue;
    if (property === "join" && isInsideApprovedOpaqueSink(access, dslBindings)) continue;
    errors.add("standard profile inspects opaque lists only through length, indexing, visible map, or prompt join");
  }

  for (const expression of [
    ...root.findAll({ rule: { kind: "binary_expression" } }),
    ...root.findAll({ rule: { kind: "unary_expression" } }),
    ...root.findAll({ rule: { kind: "ternary_expression" } }),
  ]) {
    if (isInsideBoundaryInputDefault(expression)) continue;
    if (
      expression.kind() === "binary_expression" &&
      expression.field("operator")?.text() === "+" &&
      isInsideApprovedOpaqueSink(expression, dslBindings)
    ) {
      continue;
    }
    if (containsOpaqueValue(expression, provenance, dslBindings, literalShadows)) {
      errors.add("standard profile does not compare, transform, or branch on opaque semantic values");
    }
  }

  for (const statement of [
    ...root.findAll({ rule: { kind: "if_statement" } }),
    ...root.findAll({ rule: { kind: "switch_statement" } }),
    ...root.findAll({ rule: { kind: "while_statement" } }),
    ...root.findAll({ rule: { kind: "for_statement" } }),
  ]) {
    const condition = statement.field("condition") ?? statement.field("value");
    if (condition !== null && containsOpaqueValue(condition, provenance, dslBindings, literalShadows)) {
      errors.add("standard profile control flow uses runtime-owned choices, list identity, status, or counters");
    }
  }

  for (const template of root.findAll({ rule: { kind: "template_string" } })) {
    if (
      containsOpaqueValue(template, provenance, dslBindings, literalShadows) &&
      !isInsideApprovedOpaqueSink(template, dslBindings)
    ) {
      errors.add("standard profile renders opaque values only inside an agent prompt or exact text publication");
    }
  }

  for (const identifier of [
    ...root.findAll({ rule: { kind: "identifier" } }),
    ...root.findAll({ rule: { kind: "shorthand_property_identifier" } }),
  ]) {
    if (isInsideLiteralShadow(identifier, literalShadows)) continue;
    const value = provenance.get(identifier.text());
    if (value === undefined || ["known-collection", "known-value", "runtime-control"].includes(value.kind)) continue;
    if (isStandardBindingOccurrence(identifier) || isDirectProvenanceAlias(identifier)) continue;
    if (value.kind === "void-value") {
      errors.add("standard profile does not use void DSL calls as values");
      continue;
    }
    if (value.kind === "unclassified-dsl-value") {
      errors.add("standard profile rejects DSL calls without an explicit return classification");
      continue;
    }
    if (isInsideBoundaryInputDefault(identifier) || isInsideApprovedOpaqueSink(identifier, dslBindings)) continue;
    if (value.kind === "opaque-list" && isOpaqueListStructuralUse(identifier)) continue;
    if (value.kind === "runtime-status" && isRuntimeStatusIdentityUse(identifier)) continue;
    if (isWholeValueReturnUse(identifier)) continue;
    if (isPublishedArtifactContinuationUse(identifier, value, dslBindings)) continue;
    if (isUnchangedScheduledValueUse(identifier, value, dslBindings)) continue;
    errors.add("standard profile forwards opaque semantic, model, file, host, and runtime values only as whole values");
  }
}

function standardValueProvenance(
  root: SgNode,
  runEntry: SgNode,
  dslBindings: ReadonlySet<string>,
  collections: StandardCollectionBindings,
  errors: Set<string>,
): Pick<StandardBindingModel, "literalShadows" | "provenance"> {
  const provenance = new Map<string, StandardValueProvenance>();
  const owners = new Map<string, number>();
  const duplicateNames = new Set<string>();
  const reserve = (name: string, value: StandardValueProvenance, ownerId: number): void => {
    const priorOwner = owners.get(name);
    if (priorOwner !== undefined && priorOwner !== ownerId) {
      duplicateNames.add(name);
      return;
    }
    owners.set(name, ownerId);
    provenance.set(name, value);
  };
  const parameters = standardFunctionParameterNodes(standardFunctionParameters(runEntry));
  for (const name of boundStandardNames(parameters[1])) {
    reserve(name, { kind: "opaque-value" }, parameters[1]?.id() ?? runEntry.id());
  }
  for (const [name, ownerId] of collections.owners) {
    reserve(name, { kind: "known-collection" }, ownerId);
  }

  collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);

  for (const loop of runEntry.findAll({ rule: { kind: "for_statement" } })) {
    const initializer = loop.field("initializer");
    for (const declaration of initializer?.children().filter((child) => child.kind() === "variable_declarator") ?? []) {
      const name = declaration.field("name");
      if (name?.kind() === "identifier") {
        reserve(name.text(), { kind: "runtime-control" }, declaration.id());
      }
    }
  }

  for (const loop of runEntry.findAll({ rule: { kind: "for_in_statement" } })) {
    const list = standardExpressionProvenance(loop.field("right") ?? undefined, provenance, dslBindings);
    if (list?.kind !== "opaque-list" && list?.kind !== "known-collection") continue;
    const left = loop.field("left") ?? undefined;
    if (left?.kind() !== "identifier" || !["const", "let"].includes(loop.field("kind")?.text() ?? "")) {
      errors.add("standard profile binds each opaque loop item to one unchanged identifier");
    }
    for (const name of standardLoopBindingNames(left)) {
      reserve(name, { kind: list.kind === "opaque-list" ? "opaque-value" : "known-value" }, left?.id() ?? loop.id());
    }
  }

  classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors);

  collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);
  if (duplicateNames.size > 0) {
    errors.add("standard profile gives every semantic or runtime-owned value binding one unique name");
  }
  const literalShadows: StandardLiteralShadow[] = [];
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const name = declaration.field("name");
    if (name?.kind() !== "identifier" || !provenance.has(name.text()) || owners.get(name.text()) === declaration.id()) {
      continue;
    }
    const value = standardExpressionProvenance(declaration.field("value") ?? undefined, provenance, dslBindings);
    const scope = declaration
      .ancestors()
      .find((ancestor) => ancestor.kind() === "statement_block" || ancestor.kind() === "switch_body");
    if (value === undefined && scope !== undefined) literalShadows.push({ name: name.text(), scopeId: scope.id() });
  }
  return { literalShadows, provenance };
}

function classifyStandardCallbackParameters(
  root: SgNode,
  runEntry: SgNode,
  provenance: Map<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: Set<string>,
): void {
  const callbacks = [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ];
  for (const callback of callbacks) {
    if (callback.id() === runEntry.id()) continue;
    const parameters = standardFunctionParameterNodes(standardFunctionParameters(callback));
    if (parameters.length === 0) continue;
    const ownerCall = callback.ancestors().find((ancestor) => {
      if (ancestor.kind() !== "call_expression") return false;
      return standardCallArguments(ancestor).some(
        (argument) => unwrapStandardParentheses(argument)?.id() === callback.id(),
      );
    });
    const callee = ownerCall === undefined ? undefined : unwrapStandardParentheses(callCallee(ownerCall));
    const method = callee === undefined ? undefined : directStandardDslCall(callee, dslBindings);

    if (callee?.kind() === "member_expression" && callee.field("property")?.text() === "map") {
      const receiver = standardExpressionProvenance(callee.field("object") ?? undefined, provenance, dslBindings);
      if (receiver?.kind !== "opaque-list" && receiver?.kind !== "known-collection") {
        errors.add("standard profile classifies every value-bearing callback parameter");
        continue;
      }
      const parameterKinds: StandardValueKind[] = [
        receiver.kind === "opaque-list" ? "map-item" : "known-value",
        "runtime-control",
        receiver.kind,
      ];
      classifyKnownStandardCallbackParameters(parameters, parameterKinds, reserve, errors, "map");
      continue;
    }

    const ownerArguments = ownerCall === undefined ? [] : standardCallArguments(ownerCall);
    const callbackArgumentIndex = ownerArguments.findIndex(
      (argument) => unwrapStandardParentheses(argument)?.id() === callback.id(),
    );
    if (method === "pipeline" && callbackArgumentIndex > 0) {
      classifyKnownStandardCallbackParameters(
        parameters,
        ["opaque-value", "runtime-control"],
        reserve,
        errors,
        "pipeline stage",
      );
      continue;
    }

    errors.add("standard profile classifies every value-bearing callback parameter");
  }
}

function classifyKnownStandardCallbackParameters(
  parameters: readonly SgNode[],
  kinds: readonly StandardValueKind[],
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: Set<string>,
  owner: string,
): void {
  if (parameters.length > kinds.length) {
    errors.add(`standard profile permits only documented ${owner} callback parameters`);
  }
  parameters.forEach((parameter, index) => {
    const kind = kinds[index];
    if (kind === undefined) return;
    if (parameter.kind() !== "identifier") {
      errors.add(`standard profile keeps each ${owner} callback parameter as one visible identifier`);
      return;
    }
    reserve(parameter.text(), { kind }, parameter.id());
  });
}

function collectStandardDeclarationProvenance(
  root: SgNode,
  provenance: Map<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  errors: Set<string>,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
): void {
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const value = standardExpressionProvenance(declaration.field("value") ?? undefined, provenance, dslBindings);
    if (value === undefined) continue;
    const name = declaration.field("name");
    if (name?.kind() !== "identifier") {
      errors.add("standard profile does not destructure opaque or runtime-owned values");
      continue;
    }
    reserve(name.text(), value, declaration.id());
  }
}

function standardExpressionProvenance(
  node: SgNode | undefined,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[] = [],
): StandardValueProvenance | undefined {
  const value = unwrapStandardValue(node);
  if (value === undefined) return undefined;
  if (value.kind() === "identifier" || value.kind() === "shorthand_property_identifier") {
    if (isInsideLiteralShadow(value, literalShadows)) return undefined;
    return provenance.get(value.text());
  }
  if (value.kind() === "ternary_expression" && isBoundaryInputDefaultExpression(value)) {
    return { kind: "opaque-value" };
  }
  if (value.kind() === "array") {
    return standardCompositeContainsRuntimeValue(value, provenance, dslBindings, literalShadows)
      ? { kind: "opaque-list" }
      : { kind: "known-collection" };
  }
  if (value.kind() === "object") {
    return standardCompositeContainsRuntimeValue(value, provenance, dslBindings, literalShadows)
      ? { kind: "opaque-value" }
      : undefined;
  }
  if (value.kind() === "member_expression" || value.kind() === "subscript_expression") {
    const owner = standardExpressionProvenance(
      value.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (
      owner?.kind === "runtime-status" &&
      value.kind() === "member_expression" &&
      value.field("property")?.text() === "status"
    ) {
      return { kind: "runtime-control" };
    }
    if (owner?.kind !== "opaque-list") return undefined;
    if (value.kind() === "member_expression" && value.field("property")?.text() === "length") {
      return { kind: "runtime-control" };
    }
    return { kind: "opaque-value" };
  }
  if (value.kind() !== "call_expression") return undefined;
  const callee = unwrapStandardParentheses(callCallee(value));
  if (callee === undefined) return undefined;
  const method = directStandardDslCall(callee, dslBindings);
  if (method !== undefined) return standardDslCallProvenance(method, value);
  if (callee.kind() === "member_expression" && callee.field("property")?.text() === "map") {
    const receiver = standardExpressionProvenance(
      callee.field("object") ?? undefined,
      provenance,
      dslBindings,
      literalShadows,
    );
    if (receiver?.kind === "known-collection") return { kind: "known-collection" };
    if (receiver?.kind === "opaque-list") return { kind: "opaque-list" };
  }
  return undefined;
}

function standardDslCallProvenance(method: StandardDslMethod, call: SgNode): StandardValueProvenance {
  const category: StandardDslReturnCategory | undefined = STANDARD_DSL_RETURN_CATEGORIES[method];
  if (category === undefined) return { kind: "unclassified-dsl-value", sourceMethod: method };
  if (category !== "agent-dependent") return { kind: category, sourceMethod: method };
  const optionKeys = new Set(
    standardCallArguments(call)[1]
      ?.children()
      .filter((child) => child.kind() === "pair")
      .map((pair) => staticObjectKey(pair.field("key"))) ?? [],
  );
  if (optionKeys.has("choice")) return { kind: "runtime-control", sourceMethod: method };
  if (optionKeys.has("handoffs")) return { kind: "opaque-list", sourceMethod: method };
  return { kind: "opaque-value", sourceMethod: method };
}

function standardCompositeContainsRuntimeValue(
  composite: SgNode,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): boolean {
  return standardCompositeValueExpressions(composite).some((expression) => {
    const value = standardExpressionProvenance(expression, provenance, dslBindings, literalShadows);
    return value !== undefined && value.kind !== "known-collection" && value.kind !== "known-value";
  });
}

function standardCompositeValueExpressions(composite: SgNode): SgNode[] {
  const values: SgNode[] = [];
  for (const child of composite.children()) {
    if (child.kind() === "pair") {
      const value = child.field("value");
      if (value !== null) values.push(value);
      continue;
    }
    if (child.kind() === "shorthand_property_identifier") {
      values.push(child);
      continue;
    }
    if (child.kind() === "spread_element") {
      const value = child.children().find((item) => !["...", "comment"].includes(String(item.kind())));
      if (value !== undefined) values.push(value);
      continue;
    }
    if (composite.kind() === "array" && !["[", "]", ",", "comment"].includes(String(child.kind()))) {
      values.push(child);
    }
  }
  return values;
}

function containsOpaqueValue(
  node: SgNode,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[] = [],
): boolean {
  const candidates = [
    node,
    ...[
      "call_expression",
      "identifier",
      "member_expression",
      "shorthand_property_identifier",
      "subscript_expression",
    ].flatMap((kind) => node.findAll({ rule: { kind } })),
  ];
  return candidates.some((candidate) => {
    const value = standardExpressionProvenance(candidate, provenance, dslBindings, literalShadows);
    return (
      value?.kind === "opaque-value" ||
      value?.kind === "map-item" ||
      value?.kind === "runtime-value" ||
      value?.kind === "void-value" ||
      value?.kind === "unclassified-dsl-value"
    );
  });
}

function containsNonAuthorKnownValue(
  node: SgNode | undefined,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): boolean {
  if (node === undefined) return false;
  const candidates = [
    node,
    ...[
      "array",
      "call_expression",
      "identifier",
      "member_expression",
      "object",
      "shorthand_property_identifier",
      "subscript_expression",
    ].flatMap((kind) => node.findAll({ rule: { kind } })),
  ];
  return candidates.some((candidate) => {
    const value = standardExpressionProvenance(candidate, provenance, dslBindings, literalShadows);
    return value !== undefined && value.kind !== "known-collection" && value.kind !== "known-value";
  });
}

function containsOpaqueIndexValue(
  node: SgNode | undefined,
  provenance: ReadonlyMap<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  literalShadows: readonly StandardLiteralShadow[],
): boolean {
  if (node === undefined) return false;
  const candidates = [
    node,
    ...[
      "call_expression",
      "identifier",
      "member_expression",
      "shorthand_property_identifier",
      "subscript_expression",
    ].flatMap((kind) => node.findAll({ rule: { kind } })),
  ];
  return candidates.some((candidate) => {
    const value = standardExpressionProvenance(candidate, provenance, dslBindings, literalShadows);
    return (
      value !== undefined &&
      value.kind !== "known-collection" &&
      value.kind !== "known-value" &&
      value.kind !== "runtime-control"
    );
  });
}

function standardLoopBindingNames(left: SgNode | undefined): string[] {
  if (left?.kind() !== "lexical_declaration") return boundStandardNames(left);
  return left
    .children()
    .filter((child) => child.kind() === "variable_declarator")
    .flatMap((declaration) => boundStandardNames(declaration.field("name") ?? undefined));
}

function standardCallArguments(call: SgNode): SgNode[] {
  return (
    call
      .children()
      .find((child) => child.kind() === "arguments")
      ?.children()
      .filter((child) => !["(", ")", ",", "comment"].includes(String(child.kind()))) ?? []
  );
}

function isInsideBoundaryInputDefault(node: SgNode): boolean {
  const expression =
    node.kind() === "ternary_expression"
      ? node
      : node.ancestors().find((ancestor) => ancestor.kind() === "ternary_expression");
  return expression !== undefined && isBoundaryInputDefaultExpression(expression);
}

function isInsideApprovedOpaqueSink(node: SgNode, dslBindings: ReadonlySet<string>): boolean {
  for (const call of node.ancestors().filter((ancestor) => ancestor.kind() === "call_expression")) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined) continue;
    const method = directStandardDslCall(callee, dslBindings);
    const argumentsList = standardCallArguments(call);
    const argumentIndex = argumentsList.findIndex((argument) => nodeWithinStandardNode(node, argument));
    if (argumentIndex < 0) continue;
    const approved =
      ((method === "agent" || method === "log") && argumentIndex === 0) ||
      ((method === "publishArtifact" || method === "publishPrimaryArtifact") && argumentIndex === 1);
    if (!approved) continue;
    if (node.kind() !== "identifier" && node.kind() !== "shorthand_property_identifier") return true;
    return isWholeValueOpaqueSinkPath(node, argumentsList[argumentIndex]);
  }
  return false;
}

function isWholeValueOpaqueSinkPath(node: SgNode, argument: SgNode | undefined): boolean {
  if (argument === undefined) return false;
  let current = node;
  while (current.id() !== argument.id()) {
    const parent = current.parent();
    if (parent === null || !nodeWithinStandardNode(parent, argument)) return false;
    if (parent.kind() === "binary_expression") {
      if (parent.field("operator")?.text() !== "+") return false;
    } else if (
      !["parenthesized_expression", "template_string", "template_substitution"].includes(String(parent.kind()))
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

function isInsideLiteralShadow(identifier: SgNode, shadows: readonly StandardLiteralShadow[]): boolean {
  const ancestorIds = new Set(identifier.ancestors().map((ancestor) => ancestor.id()));
  return shadows.some((shadow) => shadow.name === identifier.text() && ancestorIds.has(shadow.scopeId));
}

function isStandardBindingOccurrence(identifier: SgNode): boolean {
  for (const declaration of identifier.ancestors().filter((ancestor) => ancestor.kind() === "variable_declarator")) {
    if (nodeWithinStandardNode(identifier, declaration.field("name") ?? undefined)) return true;
  }
  for (const callable of identifier
    .ancestors()
    .filter((ancestor) =>
      ["arrow_function", "function_declaration", "function_expression"].includes(String(ancestor.kind())),
    )) {
    if (nodeWithinStandardNode(identifier, standardFunctionParameters(callable))) return true;
  }
  for (const loop of identifier.ancestors().filter((ancestor) => ancestor.kind() === "for_in_statement")) {
    if (nodeWithinStandardNode(identifier, loop.field("left") ?? undefined)) return true;
  }
  return false;
}

function isDirectProvenanceAlias(identifier: SgNode): boolean {
  const declaration = identifier.ancestors().find((ancestor) => ancestor.kind() === "variable_declarator");
  const value = unwrapStandardValue(declaration?.field("value") ?? undefined);
  return value?.id() === identifier.id();
}

function isOpaqueListStructuralUse(identifier: SgNode): boolean {
  const parent = identifier.parent();
  if (
    (parent?.kind() === "member_expression" || parent?.kind() === "subscript_expression") &&
    parent.field("object")?.id() === identifier.id()
  ) {
    return true;
  }
  const loop = identifier.ancestors().find((ancestor) => ancestor.kind() === "for_in_statement");
  if (
    loop !== undefined &&
    nodeWithinStandardNode(identifier, unwrapStandardParentheses(loop.field("right") ?? undefined))
  ) {
    return true;
  }
  return isWholeValueCallArgument(identifier, new Set(["parallel", "pipeline"]), 0);
}

function isRuntimeStatusIdentityUse(identifier: SgNode): boolean {
  const parent = identifier.parent();
  return (
    parent?.kind() === "member_expression" &&
    parent.field("object")?.id() === identifier.id() &&
    parent.field("property")?.text() === "status"
  );
}

function isWholeValueReturnUse(identifier: SgNode): boolean {
  for (const ancestor of identifier.ancestors()) {
    if (ancestor.kind() === "return_statement") return true;
    if (
      ![
        "array",
        "await_expression",
        "object",
        "pair",
        "parenthesized_expression",
        "shorthand_property_identifier",
      ].includes(String(ancestor.kind()))
    ) {
      return false;
    }
  }
  return false;
}

function isPublishedArtifactContinuationUse(
  identifier: SgNode,
  provenance: StandardValueProvenance,
  dslBindings: ReadonlySet<string>,
): boolean {
  if (
    provenance.kind !== "runtime-value" ||
    provenance.sourceMethod === undefined ||
    !STANDARD_PUBLISHED_ARTIFACT_METHODS.has(provenance.sourceMethod)
  ) {
    return false;
  }

  let element = identifier;
  while (element.parent()?.kind() === "parenthesized_expression") element = element.parent()!;
  const refs = element.parent();
  if (refs?.kind() !== "array") return false;

  const refsPair = refs.parent();
  if (
    refsPair?.kind() !== "pair" ||
    staticObjectKey(refsPair.field("key")) !== "continuationArtifactRefs" ||
    refsPair.field("value")?.id() !== refs.id()
  ) {
    return false;
  }

  const handoff = refsPair.parent();
  const handoffPair = handoff?.parent();
  if (
    handoff?.kind() !== "object" ||
    handoffPair?.kind() !== "pair" ||
    staticObjectKey(handoffPair.field("key")) !== "operatorHandoff" ||
    handoffPair.field("value")?.id() !== handoff.id()
  ) {
    return false;
  }

  const declaration = handoffPair.parent();
  if (declaration?.kind() !== "object") return false;
  const call = declaration.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined || standardCallArguments(call)[0]?.id() !== declaration.id()) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  return callee !== undefined && directStandardDslCall(callee, dslBindings) === "awaitOperator";
}

function isUnchangedScheduledValueUse(
  identifier: SgNode,
  provenance: StandardValueProvenance,
  dslBindings: ReadonlySet<string>,
): boolean {
  const pair = identifier.ancestors().find((ancestor) => ancestor.kind() === "pair");
  const shorthand = identifier.kind() === "shorthand_property_identifier" ? identifier : undefined;
  const propertyName = pair === undefined ? shorthand?.text() : staticObjectKey(pair.field("key"));
  if (propertyName === "outputDir") {
    if (provenance.kind !== "runtime-value" || provenance.sourceMethod !== "outputDir") return false;
  } else if (!["input", "item", "items", "key", "keys"].includes(propertyName ?? "")) {
    return false;
  }
  const container = pair ?? shorthand;
  const value = pair?.field("value") ?? shorthand;
  if (container === undefined || !nodeWithinStandardNode(identifier, value ?? undefined)) return false;
  if (pair !== undefined) {
    for (const ancestor of identifier.ancestors()) {
      if (ancestor.id() === container.id()) break;
      if (!["array", "parenthesized_expression"].includes(String(ancestor.kind()))) return false;
    }
  }
  const call = container.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee === undefined) return false;
  const method = directStandardDslCall(callee, dslBindings);
  return method === "invokeWorkflow" || method === "workflow";
}

function isDiscardedStandardCall(call: SgNode): boolean {
  let current = call;
  let parent = current.parent();
  while (parent !== null && ["await_expression", "parenthesized_expression"].includes(String(parent.kind()))) {
    current = parent;
    parent = current.parent();
  }
  return parent?.kind() === "expression_statement";
}

function isWholeValueCallArgument(identifier: SgNode, methods: ReadonlySet<string>, index: number): boolean {
  const call = identifier.ancestors().find((ancestor) => ancestor.kind() === "call_expression");
  if (call === undefined) return false;
  const callee = unwrapStandardParentheses(callCallee(call));
  const name =
    callee?.kind() === "identifier"
      ? callee.text()
      : callee?.kind() === "member_expression"
        ? callee.field("property")?.text()
        : undefined;
  const argument = standardCallArguments(call)[index];
  return name !== undefined && methods.has(name) && nodeWithinStandardNode(identifier, argument);
}

function nodeWithinStandardNode(node: SgNode, container: SgNode | undefined): boolean {
  return (
    container !== undefined &&
    (node.id() === container.id() || node.ancestors().some((item) => item.id() === container.id()))
  );
}

function isStandardCollectionExpression(
  node: SgNode | undefined,
  bindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
): boolean {
  const value = unwrapStandardValue(node);
  if (value?.kind() === "array") return true;
  if (value?.kind() === "identifier") return bindings.has(value.text());
  if (value?.kind() !== "call_expression") return false;
  const callee = unwrapStandardParentheses(callCallee(value));
  if (callee === undefined) return false;
  const dslMethod = directStandardDslCall(callee, dslBindings);
  if (dslMethod !== undefined) return STANDARD_COLLECTION_DSL_METHODS.has(dslMethod);
  return (
    callee.kind() === "member_expression" &&
    callee.field("property")?.text() === "map" &&
    isKnownCollectionReceiver(callee.field("object") ?? undefined, bindings, dslBindings)
  );
}

function isVisibleCollectionCall(
  call: SgNode,
  bindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
): boolean {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee?.kind() !== "member_expression") return false;
  const method = callee.field("property")?.text();
  if (!isKnownCollectionReceiver(callee.field("object") ?? undefined, bindings, dslBindings)) return false;
  if (method === "map") {
    const args = call.children().find((child) => child.kind() === "arguments");
    return (
      args?.children().some((child) => child.kind() === "arrow_function" || child.kind() === "function_expression") ===
      true
    );
  }
  if (method !== "join") return false;
  const template = call.ancestors().find((ancestor) => ancestor.kind() === "template_string");
  if (template === undefined) return false;
  return template.ancestors().some((ancestor) => {
    if (ancestor.kind() !== "call_expression") return false;
    const outer = unwrapStandardParentheses(callCallee(ancestor));
    return outer?.kind() === "identifier"
      ? outer.text() === "agent"
      : outer?.kind() === "member_expression" && outer.field("property")?.text() === "agent";
  });
}

function isKnownCollectionReceiver(
  node: SgNode | undefined,
  bindings: ReadonlySet<string>,
  dslBindings: ReadonlySet<string>,
): boolean {
  const value = unwrapStandardValue(node);
  if (value?.kind() === "identifier") return bindings.has(value.text());
  return value?.kind() === "array" || isStandardCollectionExpression(value, bindings, dslBindings);
}

function unwrapStandardValue(node: SgNode | undefined): SgNode | undefined {
  let current = unwrapStandardParentheses(node);
  while (current?.kind() === "await_expression") {
    current = unwrapStandardParentheses(
      current.children().find((child) => child.kind() !== "await" && child.kind() !== "comment"),
    );
  }
  return current;
}

/** Allow only the documented missing/blank string default at the workflow input boundary. */
function isBoundaryInputNormalization(call: SgNode): boolean {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (
    callee?.kind() !== "member_expression" ||
    callee.field("object")?.text() !== "input" ||
    callee.field("property")?.text() !== "trim"
  ) {
    return false;
  }
  const declaration = call.ancestors().find((ancestor) => ancestor.kind() === "variable_declarator");
  const value = declaration?.field("value");
  return value?.kind() === "ternary_expression" && isBoundaryInputDefaultExpression(value);
}

function isBoundaryInputDefaultExpression(value: SgNode): boolean {
  return /^typeof\s+input\s*===\s*["']string["']\s*&&\s*input\.trim\(\)\s*\?\s*input\.trim\(\)\s*:\s*["'][^"']+["']$/u.test(
    value.text(),
  );
}

function containsStandardEdgeCall(node: SgNode): boolean {
  return node
    .findAll({ rule: { kind: "call_expression" } })
    .some((call) => [...STANDARD_EDGE_METHODS].some((edge) => isDirectStandardEdgeCall(call, edge)));
}

function isVisibleInlineEdgeCallback(callback: SgNode): boolean {
  for (const ancestor of callback.ancestors()) {
    if (ancestor.kind() !== "call_expression") continue;
    const callee = unwrapStandardParentheses(callCallee(ancestor));
    const name =
      callee?.kind() === "identifier"
        ? callee.text()
        : callee?.kind() === "member_expression"
          ? callee.field("property")?.text()
          : undefined;
    if (name === "map") continue;
    return name !== undefined && STANDARD_INLINE_EDGE_OWNERS.has(name);
  }
  return false;
}

function isDirectStandardEdgeCall(call: SgNode, edge: string): boolean {
  const callee = unwrapStandardParentheses(callCallee(call));
  if (callee?.kind() === "identifier") return callee.text() === edge;
  return callee?.kind() === "member_expression" && callee.field("property")?.text() === edge;
}

function callCallee(call: SgNode): SgNode | undefined {
  return call.children().find((child) => child.kind() !== "arguments" && child.kind() !== "comment");
}

function unwrapStandardParentheses(node: SgNode | undefined): SgNode | undefined {
  let current = node;
  while (current?.kind() === "parenthesized_expression") {
    current = current
      .children()
      .find((child) => child.kind() !== "(" && child.kind() !== ")" && child.kind() !== "comment");
  }
  return current;
}

function isLiteralConstDeclaration(statement: SgNode): boolean {
  if (!statement.children().some((child) => child.kind() === "const")) return false;
  const declarations = statement.children().filter((child) => child.kind() === "variable_declarator");
  return (
    declarations.length > 0 && declarations.every((declaration) => isStaticAuthoringLiteral(declaration.field("value")))
  );
}

function isExactLiteralMetaExport(statement: SgNode, meta: SgNode): boolean {
  const declaration = statement.children().find((child) => child.kind() === "lexical_declaration");
  if (declaration === undefined || !declaration.children().some((child) => child.kind() === "const")) return false;
  const variables = declaration.children().filter((child) => child.kind() === "variable_declarator");
  return variables.length === 1 && variables[0]?.field("name")?.text() === "meta" && isStaticAuthoringLiteral(meta);
}

function staticMetaProfile(meta: SgNode): string | undefined {
  const profile = meta
    .children()
    .find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === "profile");
  return staticStringValue(profile?.field("value"));
}

function isStaticAuthoringLiteral(node: SgNode | null | undefined): boolean {
  if (node == null) return false;
  if (["false", "null", "number", "regex", "string", "true", "undefined"].includes(String(node.kind()))) return true;
  if (node.kind() === "template_string") return staticStringValue(node) !== undefined;
  if (node.kind() !== "array" && node.kind() !== "object") return false;
  return node.children().every((child) => {
    if (isStructuralLiteralNode(child)) return true;
    if (child.kind() === "pair")
      return staticObjectKey(child.field("key")) !== undefined && isStaticAuthoringLiteral(child.field("value"));
    return isStaticAuthoringLiteral(child);
  });
}

function isStructuralStatementNode(node: SgNode): boolean {
  return node.kind() === "{" || node.kind() === "}" || node.kind() === "comment" || node.kind() === ";";
}

function exportedMetaObject(statement: SgNode): SgNode | undefined {
  const declaration = statement.children().find((child) => child.kind() === "lexical_declaration");
  const variable = declaration
    ?.children()
    .find((child) => child.kind() === "variable_declarator" && child.field("name")?.text() === "meta");
  const value = variable?.field("value");
  return value?.kind() === "object" ? value : undefined;
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

function staticObjectKey(node: SgNode | null | undefined): string | undefined {
  if (node == null || node.kind() === "computed_property_name") return undefined;
  if (node.kind() === "string") return staticStringValue(node);
  return node.text();
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

function isStructuralLiteralNode(node: SgNode): boolean {
  const kind = node.kind();
  return kind === "{" || kind === "}" || kind === "[" || kind === "]" || kind === "," || kind === "comment";
}

function oneLineSourceShape(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
