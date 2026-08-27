import { Lang, parse, type SgNode } from "@ast-grep/napi";

export type WorkflowSourceDiagnosticSeverity = "error" | "warning";

export interface WorkflowSourceSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface WorkflowSourceDiagnosticRelated extends WorkflowSourceSpan {
  message: string;
}

const WORKFLOW_SOURCE_DIAGNOSTIC_CODES = {
  binding: "WF_BINDING",
  call: "WF_CALL",
  dataFlow: "WF_DATA_FLOW",
  expression: "WF_EXPRESSION",
  identifier: "WF_IDENTIFIER",
  import: "WF_IMPORT",
  metaProfile: "WF_META_PROFILE",
  phaseCaseMismatch: "WF_PHASE_CASE_MISMATCH",
  phaseDuplicateDeclaration: "WF_PHASE_DUPLICATE_DECLARATION",
  phaseOrderDrift: "WF_PHASE_ORDER_DRIFT",
  phaseUndeclared: "WF_PHASE_UNDECLARED",
  phaseUnusedDeclaration: "WF_PHASE_UNUSED_DECLARATION",
  policy: "WF_POLICY",
  runExport: "WF_RUN_EXPORT",
  sourceParse: "WF_SOURCE_PARSE",
  statement: "WF_STATEMENT",
  topLevel: "WF_TOP_LEVEL",
} as const;

export type WorkflowSourceDiagnosticCode =
  (typeof WORKFLOW_SOURCE_DIAGNOSTIC_CODES)[keyof typeof WORKFLOW_SOURCE_DIAGNOSTIC_CODES];

export interface WorkflowSourceDiagnostic extends WorkflowSourceSpan {
  code: WorkflowSourceDiagnosticCode;
  severity: WorkflowSourceDiagnosticSeverity;
  message: string;
  related?: readonly WorkflowSourceDiagnosticRelated[];
}

interface WorkflowSourceDiagnosticRelatedNode {
  message: string;
  node: SgNode;
}

interface WorkflowSourceDiagnosticSink {
  add(
    message: string,
    node?: SgNode,
    code?: WorkflowSourceDiagnosticCode,
    severity?: WorkflowSourceDiagnosticSeverity,
    related?: readonly WorkflowSourceDiagnosticRelatedNode[],
  ): void;
}

class WorkflowSourceDiagnosticBag {
  readonly #diagnostics: WorkflowSourceDiagnostic[] = [];
  readonly #keys = new Set<string>();

  sink(defaultCode: WorkflowSourceDiagnosticCode, fallbackNode?: SgNode): WorkflowSourceDiagnosticSink {
    return {
      add: (message, node = fallbackNode, code = defaultCode, severity = "error", related) => {
        this.add(code, severity, message, node, related);
      },
    };
  }

  add(
    code: WorkflowSourceDiagnosticCode,
    severity: WorkflowSourceDiagnosticSeverity,
    message: string,
    node?: SgNode,
    related?: readonly WorkflowSourceDiagnosticRelatedNode[],
  ): void {
    const span = workflowSourceSpan(node);
    const normalizedRelated = related?.map((item) => ({ message: item.message, ...workflowSourceSpan(item.node) }));
    const diagnostic: WorkflowSourceDiagnostic = {
      code,
      severity,
      message,
      ...span,
      ...(normalizedRelated !== undefined && normalizedRelated.length > 0 ? { related: normalizedRelated } : {}),
    };
    const key = workflowSourceDiagnosticIdentity(diagnostic);
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#diagnostics.push(diagnostic);
  }

  values(): WorkflowSourceDiagnostic[] {
    return [...this.#diagnostics].sort(
      (left, right) =>
        left.line - right.line ||
        left.column - right.column ||
        left.endLine - right.endLine ||
        left.endColumn - right.endColumn ||
        severityRank(left.severity) - severityRank(right.severity) ||
        compareCodeUnits(left.code, right.code) ||
        compareCodeUnits(left.message, right.message) ||
        compareCodeUnits(workflowSourceRelatedIdentity(left.related), workflowSourceRelatedIdentity(right.related)),
    );
  }
}

function workflowSourceDiagnosticIdentity(diagnostic: WorkflowSourceDiagnostic): string {
  return JSON.stringify([
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    diagnostic.line,
    diagnostic.column,
    diagnostic.endLine,
    diagnostic.endColumn,
    workflowSourceRelatedIdentity(diagnostic.related),
  ]);
}

function workflowSourceRelatedIdentity(related: readonly WorkflowSourceDiagnosticRelated[] | undefined): string {
  return JSON.stringify(
    related?.map(({ message, line, column, endLine, endColumn }) => [message, line, column, endLine, endColumn]) ?? [],
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Static authoring-profile gate. This protects the readable standard grammar;
 * it is not a runtime domain linter and does not inspect model output.
 */
export function standardWorkflowSourceShapeDiagnostics(source: string): WorkflowSourceDiagnostic[] {
  const diagnostics = new WorkflowSourceDiagnosticBag();
  let root: SgNode;
  try {
    root = parse(Lang.JavaScript, source).root();
  } catch (error) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.sourceParse,
      "error",
      `source parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return diagnostics.values();
  }
  const parseError = root.findAll({ rule: { kind: "ERROR" } })[0];
  if (parseError !== undefined) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.sourceParse,
      "error",
      `source parse failed: ${oneLineSourceShape(parseError.text())}`,
      parseError,
    );
    return diagnostics.values();
  }

  const runEntry = validateStandardTopLevel(root, diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.topLevel, root));
  validateStandardStatements(runEntry, diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.statement, runEntry ?? root));
  validateStandardDependencies(root, diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.import, root));
  validateStandardOwnedPolicy(
    root,
    runEntry,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.policy, runEntry ?? root),
  );
  validateStandardIdentifierRoots(
    root,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.identifier, runEntry ?? root),
  );
  const dslBindings = standardDslBindings(runEntry);
  validateStandardPhaseDeclarations(root, runEntry, diagnostics);
  const bindingModel = standardBindingModel(
    root,
    runEntry,
    dslBindings,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.binding, runEntry ?? root),
  );
  const protectedBindings = new Set([...dslBindings, ...bindingModel.collections.names, "Error"]);
  validateStandardExpressions(
    root,
    protectedBindings,
    dslBindings,
    bindingModel,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.expression, runEntry ?? root),
  );
  validateStandardCalls(
    root,
    runEntry,
    dslBindings,
    bindingModel.collections,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.call, runEntry ?? root),
  );
  validateStandardValueUses(
    root,
    runEntry,
    dslBindings,
    bindingModel,
    diagnostics.sink(WORKFLOW_SOURCE_DIAGNOSTIC_CODES.dataFlow, runEntry ?? root),
  );
  return diagnostics.values();
}

/** Legacy message-only projection retained for existing tests and automation. */
export function standardWorkflowSourceShapeErrors(source: string): string[] {
  return [
    ...new Set(
      standardWorkflowSourceShapeDiagnostics(source)
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message),
    ),
  ].sort();
}

function workflowSourceSpan(node: SgNode | undefined): WorkflowSourceSpan {
  if (node === undefined) return { line: 1, column: 1, endLine: 1, endColumn: 1 };
  const range = node.range();
  return {
    line: range.start.line + 1,
    column: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
  };
}

function severityRank(severity: WorkflowSourceDiagnosticSeverity): number {
  return severity === "error" ? 0 : 1;
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

interface StandardDeclaredPhase {
  title: string;
  node: SgNode;
}

interface StandardCalledPhase {
  title: string;
  node: SgNode;
}

interface StandardPhaseDslBindings {
  dsl: readonly StandardLexicalBinding[];
  phase: readonly StandardLexicalBinding[];
}

function validateStandardPhaseDeclarations(
  root: SgNode,
  runEntry: SgNode | undefined,
  diagnostics: WorkflowSourceDiagnosticBag,
): void {
  if (runEntry === undefined) return;
  const meta = root
    .children()
    .map((statement) => exportedMetaObject(statement))
    .find((value) => value !== undefined);
  const phasesPair = meta
    ?.children()
    .find((child) => child.kind() === "pair" && staticObjectKey(child.field("key")) === "phases");
  const phasesNode = phasesPair?.field("value");
  if (phasesNode?.kind() !== "array") return;

  const declared = phasesNode.children().flatMap((child): StandardDeclaredPhase[] => {
    if (child.kind() !== "object") return [];
    const titlePair = child
      .children()
      .find((entry) => entry.kind() === "pair" && staticObjectKey(entry.field("key")) === "title");
    const titleNode = titlePair?.field("value");
    const title = staticStringValue(titleNode);
    return title === undefined || titleNode == null ? [] : [{ title, node: titleNode }];
  });
  if (declared.length === 0) return;

  const lexicalBindings = standardLexicalBindings(runEntry);
  const phaseBindings = standardPhaseDslBindings(runEntry, lexicalBindings);
  const calledByTitle = new Map<string, StandardCalledPhase>();
  for (const call of runEntry.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee === undefined || !isTrustedStandardPhaseCall(call, callee, lexicalBindings, phaseBindings)) continue;
    const argument = unwrapStandardParentheses(standardCallArguments(call)[0]);
    const title = staticStringValue(argument);
    if (title !== undefined && argument !== undefined && !calledByTitle.has(title))
      calledByTitle.set(title, { title, node: argument });
  }
  const called = [...calledByTitle.values()];
  const declaredByTitle = new Map<string, StandardDeclaredPhase>();
  const firstDeclaredByFoldedTitle = new Map<string, StandardDeclaredPhase>();
  for (const phase of declared) {
    const foldedTitle = phase.title.toLowerCase();
    const first = firstDeclaredByFoldedTitle.get(foldedTitle);
    if (first !== undefined) {
      const exact = first.title === phase.title;
      diagnostics.add(
        WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseDuplicateDeclaration,
        "error",
        exact
          ? `meta.phases repeats title "${phase.title}"`
          : `meta.phases title "${phase.title}" duplicates "${first.title}" by case`,
        phase.node,
        [{ message: `first declared as "${first.title}" here`, node: first.node }],
      );
    } else {
      firstDeclaredByFoldedTitle.set(foldedTitle, phase);
    }
    if (!declaredByTitle.has(phase.title)) declaredByTitle.set(phase.title, phase);
  }

  for (const phase of called) {
    if (declaredByTitle.has(phase.title)) continue;
    const caseMatch = declared.find((candidate) => candidate.title.toLowerCase() === phase.title.toLowerCase());
    if (caseMatch !== undefined) {
      diagnostics.add(
        WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseCaseMismatch,
        "error",
        `meta.phases title "${caseMatch.title}" differs from literal phase("${phase.title}") only by case`,
        phase.node,
        [{ message: `declared as "${caseMatch.title}" here`, node: caseMatch.node }],
      );
      continue;
    }
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseUndeclared,
      "error",
      `literal phase("${phase.title}") is absent from non-empty meta.phases`,
      phase.node,
      [{ message: "meta.phases is declared here", node: phasesNode }],
    );
  }

  for (const phase of declaredByTitle.values()) {
    const exactCall = calledByTitle.get(phase.title);
    const caseCall = called.find((candidate) => candidate.title.toLowerCase() === phase.title.toLowerCase());
    if (exactCall !== undefined || caseCall !== undefined) continue;
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseUnusedDeclaration,
      "warning",
      `meta.phases title "${phase.title}" has no literal phase("${phase.title}") call`,
      phase.node,
    );
  }

  const declaredTitles = [...declaredByTitle.keys()];
  const calledTitles = [...calledByTitle.keys()];
  const sameExactSet =
    declaredTitles.length === calledTitles.length && declaredTitles.every((title) => calledByTitle.has(title));
  if (sameExactSet && declaredTitles.some((title, index) => title !== calledTitles[index])) {
    diagnostics.add(
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.phaseOrderDrift,
      "warning",
      "meta.phases order differs from first literal phase() occurrence",
      phasesNode,
      called[0] === undefined ? undefined : [{ message: "first literal phase() occurrence", node: called[0].node }],
    );
  }
}

function standardPhaseDslBindings(
  runEntry: SgNode,
  lexicalBindings: readonly StandardLexicalBinding[],
): StandardPhaseDslBindings {
  const parameters = standardFunctionParameters(runEntry);
  const firstParameter = standardFunctionParameterNodes(parameters)[0];
  const parameterBindings = new Set<string>();
  if (firstParameter?.kind() === "object_pattern") addStandardDslBindings(parameterBindings, firstParameter);

  const trustedDeclaratorIds = new Set<number>();
  const runBody = runEntry.children().find((child) => child.kind() === "statement_block");
  for (const declaration of runEntry.findAll({ rule: { kind: "variable_declarator" } })) {
    const ownerBlock = declaration.ancestors().find((ancestor) => ancestor.kind() === "statement_block");
    const pattern = declaration.field("name");
    if (
      ownerBlock?.id() !== runBody?.id() ||
      declaration.field("value")?.text() !== "dsl" ||
      pattern?.kind() !== "object_pattern"
    ) {
      continue;
    }
    const bindings = new Set<string>();
    addStandardDslBindings(bindings, pattern);
    if (bindings.has("phase")) trustedDeclaratorIds.add(declaration.id());
  }

  return {
    dsl:
      firstParameter?.kind() === "identifier" && firstParameter.text() === "dsl"
        ? lexicalBindings.filter(
            (binding) => binding.name === "dsl" && binding.bindingId === (parameters?.id() ?? firstParameter.id()),
          )
        : [],
    phase: lexicalBindings.filter(
      (binding) =>
        binding.name === "phase" &&
        ((parameterBindings.has("phase") && binding.bindingId === parameters?.id()) ||
          trustedDeclaratorIds.has(binding.bindingId)),
    ),
  };
}

function isTrustedStandardPhaseCall(
  call: SgNode,
  callee: SgNode,
  lexicalBindings: readonly StandardLexicalBinding[],
  bindings: StandardPhaseDslBindings,
): boolean {
  if (callee.kind() === "identifier" && callee.text() === "phase") {
    return hasOnlyActiveTrustedBinding(call, "phase", lexicalBindings, bindings.phase);
  }
  return (
    callee.kind() === "member_expression" &&
    callee.field("object")?.text() === "dsl" &&
    callee.field("property")?.text() === "phase" &&
    hasOnlyActiveTrustedBinding(call, "dsl", lexicalBindings, bindings.dsl)
  );
}

function hasOnlyActiveTrustedBinding(
  node: SgNode,
  name: string,
  lexicalBindings: readonly StandardLexicalBinding[],
  trustedBindings: readonly StandardLexicalBinding[],
): boolean {
  const ancestorIds = new Set(node.ancestors().map((ancestor) => ancestor.id()));
  const nodeIndex = node.range().start.index;
  const visible = lexicalBindings.filter(
    (binding) => binding.name === name && ancestorIds.has(binding.scopeId) && nodeIndex >= binding.shadowIndex,
  );
  const activeTrustedIds = new Set(
    trustedBindings
      .filter(
        (binding) =>
          ancestorIds.has(binding.scopeId) && nodeIndex >= binding.shadowIndex && nodeIndex >= binding.activationIndex,
      )
      .map((binding) => binding.bindingId),
  );
  return activeTrustedIds.size > 0 && visible.every((binding) => activeTrustedIds.has(binding.bindingId));
}

/** Validate the closed standard module surface and return its one visible run function. */
function validateStandardTopLevel(root: SgNode, errors: WorkflowSourceDiagnosticSink): SgNode | undefined {
  let metaCount = 0;
  const runEntries: SgNode[] = [];
  for (const statement of root.children()) {
    if (statement.kind() === "comment" || statement.kind() === "hash_bang_line" || statement.kind() === ";") continue;
    if (statement.kind() === "lexical_declaration") {
      if (!isLiteralConstDeclaration(statement)) {
        errors.add("standard profile top-level constants must contain only literal data", statement);
      }
      continue;
    }
    if (statement.kind() !== "export_statement") {
      errors.add(
        "standard profile top level permits only literal constants, literal meta, and one default run export",
        statement,
      );
      continue;
    }

    const meta = exportedMetaObject(statement);
    if (meta !== undefined) {
      metaCount += 1;
      if (!isExactLiteralMetaExport(statement, meta) || staticMetaProfile(meta) !== "standard") {
        errors.add(
          'standard profile requires one literal `export const meta` with `profile: "standard"`',
          statement,
          WORKFLOW_SOURCE_DIAGNOSTIC_CODES.metaProfile,
        );
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
        errors.add(
          "standard profile run export is named run or runWorkflow",
          entry.field("name") ?? entry,
          WORKFLOW_SOURCE_DIAGNOSTIC_CODES.runExport,
        );
      }
      runEntries.push(entry);
      continue;
    }

    errors.add("standard profile exports only literal meta and one visible default run function", statement);
  }
  if (metaCount !== 1) {
    errors.add(
      'standard profile requires one literal `export const meta` with `profile: "standard"`',
      root,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.metaProfile,
    );
  }
  if (runEntries.length !== 1) {
    errors.add(
      "standard profile requires exactly one visible default run function",
      root,
      WORKFLOW_SOURCE_DIAGNOSTIC_CODES.runExport,
    );
  }
  return runEntries.length === 1 ? runEntries[0] : undefined;
}

/** Standard orchestration uses ordinary declarations/control flow, never hidden statement machinery. */
function validateStandardStatements(runEntry: SgNode | undefined, errors: WorkflowSourceDiagnosticSink): void {
  if (runEntry === undefined) return;
  for (const block of runEntry.findAll({ rule: { kind: "statement_block" } })) {
    for (const statement of block.children()) {
      if (isStructuralStatementNode(statement)) continue;
      if (!STANDARD_STATEMENTS.has(String(statement.kind()))) {
        errors.add(`standard profile does not permit ${statement.kind()} in the run body`, statement);
      }
    }
  }
}

function validateStandardDependencies(root: SgNode, errors: WorkflowSourceDiagnosticSink): void {
  for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    errors.add(
      specifier?.startsWith("node:") === true
        ? "standard profile imports no node: modules"
        : "standard profile imports no modules",
      statement,
    );
  }
  for (const statement of root.findAll({ rule: { kind: "export_statement" } })) {
    if (!statement.children().some((child) => child.kind() === "from")) continue;
    const specifier = staticStringValue(statement.children().find((child) => child.kind() === "string"));
    errors.add(
      specifier?.startsWith("node:") === true
        ? "standard profile re-exports no node: modules"
        : "standard profile re-exports no modules",
      statement,
    );
  }
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee?.kind() === "import") {
      errors.add("standard profile uses no dynamic imports", call);
    } else if (callee?.kind() === "identifier" && callee.text() === "require") {
      errors.add("standard profile uses no require() imports", call);
    }
  }
}

function validateStandardOwnedPolicy(
  root: SgNode,
  runEntry: SgNode | undefined,
  errors: WorkflowSourceDiagnosticSink,
): void {
  for (const statement of root.findAll({ rule: { kind: "try_statement" } })) {
    errors.add("standard profile owns no try/catch recovery", statement);
  }
  for (const declaration of root.findAll({ rule: { kind: "class_declaration" } })) {
    errors.add("standard profile owns no class helpers", declaration);
  }
  for (const pair of root.findAll({ rule: { kind: "pair" } })) {
    const key = staticObjectKey(pair.field("key"));
    if (key === "schema" || key === "validate") errors.add(`standard profile owns no raw ${key}`, pair);
  }
  for (const property of root.findAll({ rule: { kind: "computed_property_name" } })) {
    errors.add("standard profile uses no computed object keys that hide policy", property);
  }
  for (const regex of root.findAll({ rule: { kind: "regex" } })) {
    errors.add("standard profile owns no regex gates", regex);
  }
  for (const declaration of root.findAll({ rule: { kind: "function_declaration" } })) {
    if (declaration.id() === runEntry?.id()) continue;
    const name = declaration.field("name")?.text() ?? "anonymous";
    errors.add(`standard profile keeps no nested or top-level helper function ${name}`, declaration);
  }
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const name = declaration.field("name")?.text() ?? "";
    const value = declaration.field("value");
    if (value?.kind() === "arrow_function" || value?.kind() === "function_expression") {
      errors.add(`standard profile keeps no function-valued helper ${name || "binding"}`, declaration);
    }
  }
  for (const callback of [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ]) {
    if (callback.id() === runEntry?.id()) continue;
    if (callback.kind() === "function_expression") {
      errors.add("standard profile uses arrow functions for inline callbacks", callback);
    }
    const owner = callback.parent();
    if (owner?.kind() === "pair" || owner?.kind() === "variable_declarator") {
      errors.add("standard profile keeps no object or variable function wrapper", callback);
    } else if (containsStandardEdgeCall(callback) && !isVisibleInlineEdgeCallback(callback)) {
      errors.add(
        "standard profile keeps inline agent edges only inside visible parallel, pipeline, or workflow calls",
        callback,
      );
    }
  }
  for (const method of root.findAll({ rule: { kind: "method_definition" } })) {
    errors.add(
      `standard profile keeps no object/class method helper ${method.field("name")?.text() ?? "method"}`,
      method,
    );
  }
}

interface StandardLexicalBinding {
  activationIndex: number;
  bindingId: number;
  name: string;
  shadowIndex: number;
  scopeId: number;
}

function validateStandardIdentifierRoots(root: SgNode, errors: WorkflowSourceDiagnosticSink): void {
  const bindings = standardLexicalBindings(root);
  const approvedGlobals = new Set(["Error"]);
  for (const rootValue of [
    ...root.findAll({ rule: { kind: "this" } }),
    ...root.findAll({ rule: { kind: "meta_property" } }),
  ]) {
    errors.add(
      "standard profile reads values only from declared lexical bindings and approved language roots",
      rootValue,
    );
  }
  for (const identifier of [
    ...root.findAll({ rule: { kind: "identifier" } }),
    ...root.findAll({ rule: { kind: "shorthand_property_identifier" } }),
  ]) {
    if (identifier.text() === "arguments") {
      errors.add("standard profile does not use the implicit arguments object", identifier);
      continue;
    }
    if (approvedGlobals.has(identifier.text())) continue;
    if (isStandardBindingOccurrence(identifier)) continue;
    const ancestorIds = new Set(identifier.ancestors().map((ancestor) => ancestor.id()));
    const identifierIndex = identifier.range().start.index;
    if (
      bindings.some(
        (binding) =>
          binding.name === identifier.text() &&
          identifierIndex >= binding.activationIndex &&
          (binding.scopeId === root.id() || ancestorIds.has(binding.scopeId)),
      )
    ) {
      continue;
    }
    errors.add(
      "standard profile reads values only from declared lexical bindings and approved language roots",
      identifier,
    );
  }
}

function standardLexicalBindings(root: SgNode): StandardLexicalBinding[] {
  const bindings: StandardLexicalBinding[] = [];
  const add = (
    names: readonly string[],
    scope: SgNode,
    bindingId: number,
    activationIndex = scope.range().start.index,
    shadowIndex = scope.range().start.index,
  ): void => {
    for (const name of names) bindings.push({ activationIndex, bindingId, name, shadowIndex, scopeId: scope.id() });
  };

  for (const callable of [
    ...root.findAll({ rule: { kind: "arrow_function" } }),
    ...root.findAll({ rule: { kind: "function_declaration" } }),
    ...root.findAll({ rule: { kind: "function_expression" } }),
  ]) {
    const parameters = standardFunctionParameters(callable);
    add(boundStandardNames(parameters), callable, parameters?.id() ?? callable.id());
    const name = callable.field("name")?.text();
    if (name === undefined) continue;
    add(
      [name],
      callable.kind() === "function_expression" ? callable : standardLexicalOwner(callable, root),
      callable.id(),
    );
  }

  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const scope = standardLexicalOwner(declaration, root);
    const functionScoped =
      declaration
        .ancestors()
        .find((ancestor) => ["lexical_declaration", "variable_declaration"].includes(String(ancestor.kind())))
        ?.kind() === "variable_declaration";
    const activationIndex = functionScoped
      ? scope.range().start.index
      : (declaration.field("value")?.range().end.index ?? declaration.range().end.index);
    add(boundStandardNames(declaration.field("name") ?? undefined), scope, declaration.id(), activationIndex);
  }
  for (const loop of root.findAll({ rule: { kind: "for_in_statement" } })) {
    add(
      standardLoopBindingNames(loop.field("left") ?? undefined),
      loop,
      loop.id(),
      loop.field("left")?.range().end.index ?? loop.range().start.index,
    );
  }
  return bindings;
}

function standardLexicalOwner(node: SgNode, root: SgNode): SgNode {
  if (node.ancestors().some((ancestor) => ancestor.kind() === "variable_declaration")) {
    return (
      node
        .ancestors()
        .find((ancestor) =>
          ["arrow_function", "function_declaration", "function_expression"].includes(String(ancestor.kind())),
        ) ?? root
    );
  }
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
  errors: WorkflowSourceDiagnosticSink,
): void {
  for (const expression of root.findAll({ rule: { kind: "sequence_expression" } })) {
    errors.add("standard profile uses no sequence expressions", expression);
  }
  for (const expression of [
    ...root.findAll({ rule: { kind: "assignment_expression" } }),
    ...root.findAll({ rule: { kind: "augmented_assignment_expression" } }),
    ...root.findAll({ rule: { kind: "update_expression" } }),
  ]) {
    if (!isOwnedForLoopCounterMutation(expression, protectedBindings)) {
      errors.add("standard profile does not mutate semantic values or build parser/renderer accumulators", expression);
    }
  }
  for (const expression of root.findAll({ rule: { kind: "new_expression" } })) {
    if (unwrapStandardParentheses(expression.field("constructor") ?? undefined)?.text() !== "Error") {
      errors.add("standard profile constructs no helper, parser, renderer, or ledger objects", expression);
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
      errors.add("standard profile constructs Error only from author-known or literal values", expression);
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
  errors: WorkflowSourceDiagnosticSink,
): void {
  validateStandardBindingShadows(root, runEntry, dslBindings, collectionBindings, errors);
  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const callee = unwrapStandardParentheses(callCallee(call));
    if (callee == null || callee.kind() === "import") continue;
    if (callee.kind() === "subscript_expression") {
      errors.add("standard profile uses no computed calls that can hide orchestration or semantic transforms", call);
      continue;
    }
    const directDsl = directStandardDslCall(callee, dslBindings);
    if (
      directDsl === undefined &&
      !isVisibleCollectionCall(call, collectionBindings.names, dslBindings) &&
      !isBoundaryInputNormalization(call)
    ) {
      errors.add("standard profile calls only direct DSL primitives and visible map/prompt-join operations", call);
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
  errors: WorkflowSourceDiagnosticSink,
): void {
  if (runEntry === undefined) return;
  const protectedNames = new Set([...dslBindings, ...collectionBindings.names, "Error"]);
  const runParameters = standardFunctionParameters(runEntry);
  for (const name of boundStandardNames(runParameters)) {
    if (name === "Error") errors.add("standard profile does not shadow the global Error constructor", runParameters);
  }

  for (const callback of [
    ...runEntry.findAll({ rule: { kind: "arrow_function" } }),
    ...runEntry.findAll({ rule: { kind: "function_expression" } }),
    ...runEntry.findAll({ rule: { kind: "function_declaration" } }),
  ]) {
    if (callback.id() === runEntry.id()) continue;
    const parameters = standardFunctionParameters(callback);
    if (boundStandardNames(parameters).some((name) => protectedNames.has(name))) {
      errors.add("standard profile nested callbacks do not shadow trusted DSL or collection bindings", callback);
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
      errors.add("standard profile loop, switch, and nested bindings do not shadow trusted names", declaration);
    }
  }
  for (const loop of runEntry.findAll({ rule: { kind: "for_in_statement" } })) {
    if (boundStandardNames(loop.field("left") ?? undefined).some((name) => protectedNames.has(name))) {
      errors.add("standard profile loop bindings do not shadow trusted DSL, collection, or Error names", loop);
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
  errors: WorkflowSourceDiagnosticSink,
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
  errors: WorkflowSourceDiagnosticSink,
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
      errors.add("standard profile rejects DSL calls without an explicit return classification", call);
    } else if (value.kind === "void-value" && !isDiscardedStandardCall(call)) {
      errors.add("standard profile does not use void DSL calls as values", call);
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
      errors.add("standard profile does not select a subscript with opaque semantic or model-produced values", access);
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
          access,
        );
      }
      continue;
    }
    if (owner.kind === "runtime-status") {
      if (access.kind() === "member_expression" && access.field("property")?.text() === "status") continue;
      errors.add("standard profile reads only the exact status identity from a runtime-owned result", access);
      continue;
    }
    if (owner.kind === "runtime-control") {
      errors.add("standard profile uses runtime-owned control values only by exact identity", access);
      continue;
    }
    if (access.kind() === "subscript_expression") continue;
    const property = access.field("property")?.text();
    if (property === "length" || property === "map") continue;
    if (property === "join" && isInsideApprovedOpaqueSink(access, dslBindings)) continue;
    errors.add(
      "standard profile inspects opaque lists only through length, indexing, visible map, or prompt join",
      access,
    );
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
      errors.add("standard profile does not compare, transform, or branch on opaque semantic values", expression);
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
      errors.add(
        "standard profile control flow uses runtime-owned choices, list identity, status, or counters",
        condition ?? statement,
      );
    }
  }

  for (const template of root.findAll({ rule: { kind: "template_string" } })) {
    if (
      containsOpaqueValue(template, provenance, dslBindings, literalShadows) &&
      !isInsideApprovedOpaqueSink(template, dslBindings)
    ) {
      errors.add(
        "standard profile renders opaque values only inside an agent prompt or exact text publication",
        template,
      );
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
      errors.add("standard profile does not use void DSL calls as values", identifier);
      continue;
    }
    if (value.kind === "unclassified-dsl-value") {
      errors.add("standard profile rejects DSL calls without an explicit return classification", identifier);
      continue;
    }
    if (isInsideBoundaryInputDefault(identifier) || isInsideApprovedOpaqueSink(identifier, dslBindings)) continue;
    if (value.kind === "opaque-list" && isOpaqueListStructuralUse(identifier)) continue;
    if (value.kind === "runtime-status" && isRuntimeStatusIdentityUse(identifier)) continue;
    if (isWholeValueReturnUse(identifier)) continue;
    if (isPublishedArtifactContinuationUse(identifier, value, dslBindings)) continue;
    if (isPublishedArtifactHandoffDetailUse(identifier, value, dslBindings)) continue;
    if (isUnchangedScheduledValueUse(identifier, value, dslBindings)) continue;
    errors.add(
      "standard profile forwards opaque semantic, model, file, host, and runtime values only as whole values",
      identifier,
    );
  }
}

function standardValueProvenance(
  root: SgNode,
  runEntry: SgNode,
  dslBindings: ReadonlySet<string>,
  collections: StandardCollectionBindings,
  errors: WorkflowSourceDiagnosticSink,
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
      errors.add("standard profile binds each opaque loop item to one unchanged identifier", left ?? loop);
    }
    for (const name of standardLoopBindingNames(left)) {
      reserve(name, { kind: list.kind === "opaque-list" ? "opaque-value" : "known-value" }, left?.id() ?? loop.id());
    }
  }

  classifyStandardCallbackParameters(root, runEntry, provenance, dslBindings, reserve, errors);

  collectStandardDeclarationProvenance(root, provenance, dslBindings, errors, reserve);
  if (duplicateNames.size > 0) {
    errors.add("standard profile gives every semantic or runtime-owned value binding one unique name", runEntry);
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
  errors: WorkflowSourceDiagnosticSink,
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
        errors.add("standard profile classifies every value-bearing callback parameter", callback);
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

    errors.add("standard profile classifies every value-bearing callback parameter", callback);
  }
}

function classifyKnownStandardCallbackParameters(
  parameters: readonly SgNode[],
  kinds: readonly StandardValueKind[],
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
  errors: WorkflowSourceDiagnosticSink,
  owner: string,
): void {
  if (parameters.length > kinds.length) {
    errors.add(
      `standard profile permits only documented ${owner} callback parameters`,
      parameters[kinds.length] ?? parameters.at(-1),
    );
  }
  parameters.forEach((parameter, index) => {
    const kind = kinds[index];
    if (kind === undefined) return;
    if (parameter.kind() !== "identifier") {
      errors.add(`standard profile keeps each ${owner} callback parameter as one visible identifier`, parameter);
      return;
    }
    reserve(parameter.text(), { kind }, parameter.id());
  });
}

function collectStandardDeclarationProvenance(
  root: SgNode,
  provenance: Map<string, StandardValueProvenance>,
  dslBindings: ReadonlySet<string>,
  errors: WorkflowSourceDiagnosticSink,
  reserve: (name: string, value: StandardValueProvenance, ownerId: number) => void,
): void {
  for (const declaration of root.findAll({ rule: { kind: "variable_declarator" } })) {
    const value = standardExpressionProvenance(declaration.field("value") ?? undefined, provenance, dslBindings);
    if (value === undefined) continue;
    const name = declaration.field("name");
    if (name?.kind() !== "identifier") {
      errors.add("standard profile does not destructure opaque or runtime-owned values", name ?? declaration);
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

function isPublishedArtifactHandoffDetailUse(
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
  const detailPair = identifier.ancestors().find((ancestor) => ancestor.kind() === "pair");
  if (
    detailPair === undefined ||
    staticObjectKey(detailPair.field("key")) !== "detailArtifactRef" ||
    !nodeWithinStandardNode(identifier, detailPair.field("value") ?? undefined)
  ) {
    return false;
  }
  const question = detailPair.parent();
  const questions = question?.parent();
  const questionsPair = questions?.parent();
  if (
    question?.kind() !== "object" ||
    questions?.kind() !== "array" ||
    questionsPair?.kind() !== "pair" ||
    staticObjectKey(questionsPair.field("key")) !== "questions"
  ) {
    return false;
  }
  const handoff = questionsPair.parent();
  const handoffPair = handoff?.parent();
  if (
    handoff?.kind() !== "object" ||
    handoffPair?.kind() !== "pair" ||
    staticObjectKey(handoffPair.field("key")) !== "operatorHandoff"
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
