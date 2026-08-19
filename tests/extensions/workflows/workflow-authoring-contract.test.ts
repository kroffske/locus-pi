import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { staticWorkflowMeta } from "../../../extensions/workflows/workflow-catalog.js";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";
import { packagedWorkflowNames, packagedWorkflowPath } from "../../../extensions/workflows/runtime/workflow-runner.js";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function standardSource(run: string, declarations = ""): string {
  return [
    'export const meta = { name: "contract-test", profile: "standard", description: "Contract test." };',
    declarations,
    run,
  ]
    .filter(Boolean)
    .join("\n");
}

function javascriptDocSnippets(relativePath: string): string[] {
  return [...source(relativePath).matchAll(/```(?:js|javascript|mjs)\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");
}

function declaredStandardDocSnippets(relativePath: string): string[] {
  return javascriptDocSnippets(relativePath).filter((snippet) => /profile:\s*["']standard["']/u.test(snippet));
}

const STANDARD_DSL_RETURN_CASES = [
  { method: "agent", call: 'dsl.agent("x")', category: "opaque" },
  { method: "awaitOperator", call: 'dsl.awaitOperator({ reason: "stop" })', category: "void" },
  {
    method: "consumeTextArtifact",
    call: 'dsl.consumeTextArtifact({ path: "x", bytes: 1, sha256: "x" })',
    category: "opaque",
  },
  { method: "continuationArtifacts", call: "dsl.continuationArtifacts()", category: "list" },
  {
    method: "invokeWorkflow",
    call: 'dsl.invokeWorkflow({ child: "worker", key: "one", keys: ["one"], outputDir: dsl.outputDir() })',
    category: "status",
  },
  { method: "items", call: "dsl.items()", category: "list" },
  { method: "log", call: 'dsl.log("x")', category: "void" },
  { method: "now", call: "dsl.now()", category: "runtime" },
  { method: "outputDir", call: "dsl.outputDir()", category: "runtime" },
  { method: "parallel", call: 'dsl.parallel([() => dsl.agent("x")])', category: "list" },
  { method: "phase", call: 'dsl.phase("x")', category: "void" },
  { method: "pipeline", call: 'dsl.pipeline(["x"], (item) => dsl.agent(item))', category: "list" },
  { method: "projectRoot", call: "dsl.projectRoot()", category: "runtime" },
  { method: "promptFile", call: 'dsl.promptFile("x.prompt.md")', category: "opaque" },
  { method: "publishArtifact", call: 'dsl.publishArtifact("x.md", "x")', category: "runtime" },
  {
    method: "publishPrimaryArtifact",
    call: 'dsl.publishPrimaryArtifact("x.md", "x")',
    category: "runtime",
  },
  { method: "publishPrimaryFile", call: 'dsl.publishPrimaryFile("x.md")', category: "runtime" },
  { method: "random", call: "dsl.random()", category: "runtime" },
  { method: "workflow", call: 'dsl.workflow(() => dsl.agent("x"))', category: "opaque" },
  { method: "workspace", call: 'dsl.workspace("work", "HEAD")', category: "opaque" },
] as const;

function dslReturnSource(call: string, body: string): string {
  return standardSource(`export default async function run(dsl) {
  const value = await ${call};
  ${body}
}`);
}

describe("design-first readable workflow authoring", () => {
  const authoringSurfaces = [
    "skills/locus-pi-workflows/SKILL.md",
    ".agents/agents/workflow-author.md",
    "extensions/workflows/AUTHORING.md",
    "extensions/workflows/REFERENCE.md",
    "extensions/workflows/workflow-tool.ts",
    "extensions/workflows/manifest.json",
    "extensions/workflows/examples/README.md",
  ];

  it.each(authoringSurfaces)("keeps Design -> review -> Build continuous by default on %s", (relativePath) => {
    const text = source(relativePath);
    expect(text).toContain(".design.md");
    expect(text).toContain("Build design:");
    expect(text).toContain("Build approved design:");
    expect(text).toMatch(/design[- ]only|pause after design/iu);
  });

  const planAuthoringSurfaces = [
    "extensions/workflows/examples/task/plan.workflow.mjs",
    "extensions/workflows/examples/task/README.md",
    "extensions/workflows/examples/task-via-script/resources/implement-template.prompt.md",
    "skills/locus-pi-workflows/references/plan-to-sequential-workflow.md",
    "skills/locus-task-workflow/SKILL.md",
  ];

  it.each(planAuthoringSurfaces)("keeps the bespoke Plan handoff continuous on %s", (relativePath) => {
    const text = source(relativePath);
    expect(text).toMatch(
      /normal authoring request|ordinary continuous (?:authoring|request)|continuous-authoring route/iu,
    );
    expect(text).toMatch(/writes Design[\s\S]{0,80}reviews\s+it[\s\S]{0,80}Builds/iu);
    expect(text).toMatch(/(?:Do not[\s\S]{0,80}inject|no agent-injected)[\s\S]{0,40}`?Design\s+only/iu);
    expect(text).not.toContain("Design workflow:");
    expect(text).not.toContain("Build approved design: <exact design path>");
  });

  it("documents the task family boundary and continuous bespoke authoring route", () => {
    const text = source("extensions/workflows/examples/task/README.md");
    expect(text).toContain("`task` is a group-only Package namespace");
    expect(text).toContain("`task/draft` to translate a raw request");
    expect(text).toContain("`task/plan` to prepare an accepted task");
    expect(text).toContain("`task/implement` to execute the complete approved plan");
    expect(text).toMatch(/The author writes Design,\s+reviews it, and Builds matching source in the same turn/u);
    expect(text).toContain("only the user may separately request a pause");
    expect(text).toContain("`task/implement` is intentionally different from the separate `implement`");
  });

  it("keeps CLI syntax target-first on every active manual speaker", () => {
    const canonical =
      "/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]";
    for (const relativePath of [
      "skills/locus-pi-run-workflow/SKILL.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/references/patterns.md",
    ]) {
      expect(source(relativePath)).toContain(canonical);
    }
    expect(source("extensions/workflows/REFERENCE.md")).not.toContain("/workflow-run <name|path>");
    for (const relativePath of ["extensions/workflows/REFERENCE.md", "docs/workflows.md"]) {
      const text = source(relativePath);
      expect(text).toContain("--run-name <name>");
      expect(text).toContain("--output-dir <path>");
      expect(text).not.toContain("/workflows run --output-dir <path>");
    }
  });

  it.each([
    "skills/locus-pi-workflows/SKILL.md",
    ".agents/agents/workflow-author.md",
    "extensions/workflows/AUTHORING.md",
    "extensions/workflows/REFERENCE.md",
  ])("publishes the runnable standard source gate on %s", (relativePath) => {
    expect(source(relativePath)).toContain("npx @kroffske/locus-pi check-workflow-source");
  });

  it("makes workflow-author source-checking fail closed in a source checkout", () => {
    for (const relativePath of [".agents/agents/workflow-author.md", "skills/locus-pi-workflows/SKILL.md"]) {
      const text = source(relativePath);
      expect(text).toContain("./bin/locus-pi check-workflow-source");
      expect(text).toMatch(/non-zero checker exit/iu);
      expect(text).toMatch(/never (?:report|return).*successful Build/isu);
    }
  });

  it("keeps the manual hello-world inside the enforced input-normalization grammar", () => {
    expect(source("extensions/workflows/REFERENCE.md")).toContain(
      'const task = typeof input === "string" && input.trim() ? input.trim() : "list the cwd";',
    );
  });

  it("runs every public declared-standard documentation snippet through the source checker", () => {
    const documents = [
      "extensions/workflows/AUTHORING.md",
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/REFERENCE.md",
      "extensions/workflows/examples/README.md",
      "README.md",
    ];
    const snippets = documents.flatMap((relativePath) =>
      declaredStandardDocSnippets(relativePath).map((snippet, index) => ({ index, relativePath, snippet })),
    );
    expect(snippets.length).toBeGreaterThan(0);
    for (const { index, relativePath, snippet } of snippets) {
      expect(standardWorkflowSourceShapeErrors(snippet), `${relativePath} standard snippet ${index + 1}`).toEqual([]);
    }
  });

  it("keeps standard teaching free of author-side capability and answer engineering", () => {
    const documents = [
      "extensions/workflows/AUTHORING.md",
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/REFERENCE.md",
      "extensions/workflows/examples/README.md",
      "README.md",
    ];
    const snippets = documents.flatMap((relativePath) => declaredStandardDocSnippets(relativePath));
    for (const snippet of snippets) {
      expect(snippet).not.toMatch(/\b(?:tools|readOnly|permissionMode|sandbox|schema|validate)\s*:/u);
      expect(snippet).not.toMatch(/function\s+(?:parse|validate|render|repair|acknowledge)\w*/iu);
    }
  });

  it("teaches one project-local workflow workspace separate from two-zone run evidence", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "docs/workflows.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain("<pwd>/tmp/<workflow-name>");
      expect(text).not.toContain("outputs/<workflow-name>");
    }
    const storage = source("docs/workflows.md");
    expect(storage).toContain("runs/<runId>/");
    expect(storage).toContain("outputs/    human-readable host projection");
    expect(storage).toContain("runtime/    machine evidence and continuation authority");
    expect(storage).toContain("must never resolve to the same directory");
  });

  it("checks every AUTHORING and installed-SKILL standard teaching fragment", () => {
    const authoring = javascriptDocSnippets("extensions/workflows/AUTHORING.md");
    const skill = javascriptDocSnippets("skills/locus-pi-workflows/SKILL.md");
    expect(authoring).toHaveLength(5);
    expect(skill).toHaveLength(2);

    const fragments = [
      {
        label: "AUTHORING choice fragment",
        source: standardSource(`export default async function run({ agent }) {
${authoring[0] ?? ""}
  return route;
}`),
      },
      {
        label: "AUTHORING handoffs fragment",
        source: standardSource(`export default async function run({ agent }) {
${authoring[1] ?? ""}
  return units;
}`),
      },
      ...authoring.slice(2).map((snippet, index) => ({
        label: `AUTHORING complete snippet ${index + 1}`,
        source: snippet,
      })),
      { label: "SKILL standard harness", source: standardSource(skill[0] ?? "") },
      {
        label: "SKILL durable fragment",
        source: standardSource(`export default async function runWorkflow(dsl) {
${skill[1] ?? ""}
}`),
      },
    ];
    for (const fragment of fragments) {
      expect(standardWorkflowSourceShapeErrors(fragment.source), fragment.label).toEqual([]);
    }
  });

  it("keeps unused acknowledgement protocols review-owned instead of parsing prompt English", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).toMatch(/acknowledgement/iu);
      expect(text).toMatch(/review/iu);
      expect(text).toMatch(/prompt[- ]English/iu);
    }
  });

  it("classifies every allowed standard DSL method exactly once", () => {
    expect(STANDARD_DSL_RETURN_CASES.map(({ method }) => method)).toEqual([
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
    ]);
  });

  it("rejects the removed runWorkspaceDir from standard source", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource("export default function run(dsl) { return dsl.runWorkspaceDir(); }"),
      ),
    ).toContain("standard profile calls only direct DSL primitives and visible map/prompt-join operations");
  });

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "allows $method as one bound whole return",
    ({ call }) => {
      expect(standardWorkflowSourceShapeErrors(dslReturnSource(call, "return value;"))).toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "rejects semantic branching on $method",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(
          dslReturnSource(call, 'if (value) return dsl.agent("yes"); return dsl.agent("no");'),
        ),
      ).not.toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "rejects undocumented member inspection on $method",
    ({ call }) => {
      expect(standardWorkflowSourceShapeErrors(dslReturnSource(call, "return value.detail;"))).not.toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category !== "void"))(
    "rejects $method inside nested Error arguments",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(dslReturnSource(call, 'throw new Error("stop", { cause: [value] });')),
      ).toContain("standard profile constructs Error only from author-known or literal values");
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "void"))(
    "allows discarded $method",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(
          standardSource(`export default async function run(dsl) {
  await ${call};
  return true;
}`),
        ),
      ).toEqual([]);
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "void"))(
    "rejects $method used as a value",
    ({ call }) => {
      expect(standardWorkflowSourceShapeErrors(dslReturnSource(call, "return value;"))).toContain(
        "standard profile does not use void DSL calls as values",
      );
    },
  );

  it.each(STANDARD_DSL_RETURN_CASES.filter(({ category }) => category === "list"))(
    "allows documented list-length control from $method",
    ({ call }) => {
      expect(
        standardWorkflowSourceShapeErrors(
          dslReturnSource(call, 'if (value.length === 0) dsl.log("empty"); return value;'),
        ),
      ).toEqual([]);
    },
  );

  it("allows exact choice identity and saved-child status controls", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const route = await dsl.agent("route", { choice: ["yes", "no"] });
  if (route === "yes") dsl.log(route);
  const child = await dsl.invokeWorkflow({
    name: "child",
    key: "one",
    keys: ["one"],
    outputDir: dsl.outputDir(),
  });
  if (child.status === "completed") return route;
  return child.status;
}`),
      ),
    ).toEqual([]);
  });

  it("allows a bound outputDir only in the matching saved-child field", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const stableOutputDir = dsl.outputDir();
  return dsl.invokeWorkflow({
    name: "child",
    key: "one",
    keys: ["one"],
    outputDir: stableOutputDir,
  });
}`),
      ),
    ).toEqual([]);
  });

  it.each([
    ["publishArtifact", 'dsl.publishArtifact("intent.md", "intent")'],
    ["publishPrimaryArtifact", 'dsl.publishPrimaryArtifact("intent.md", "intent")'],
    ["publishPrimaryFile", 'dsl.publishPrimaryFile("intent.md")'],
  ])("allows an unchanged %s ref in the exact operator handoff continuation array", (_method, call) => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const artifactRef = ${call};
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [artifactRef],
    },
  });
  return true;
}`),
      ),
    ).toEqual([]);
  });

  it("allows one published artifact ref as verified question detail and continuation input", () => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  const blockerRef = dsl.publishArtifact("planning-blocker.md", "# Question\\nChoose a policy.");
  dsl.awaitOperator({
    reason: "planning blocked",
    operatorHandoff: {
      title: "Planning blocker",
      questions: [{
        kind: "select",
        id: "decision",
        prompt: "How should planning proceed?",
        detailArtifactRef: blockerRef,
        options: [{ label: "Use an assumption" }],
        allowCustom: true,
      }],
      continuationArtifactRefs: [blockerRef],
    },
  });
  return true;
}`),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "unrelated runtime value",
      `const artifactRef = dsl.outputDir();
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [artifactRef],
    },
  });`,
    ],
    [
      "unrelated operator handoff field",
      `const artifactRef = dsl.publishArtifact("intent.md", "intent");
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: artifactRef,
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [],
    },
  });`,
    ],
    [
      "nested continuation element",
      `const artifactRef = dsl.publishArtifact("intent.md", "intent");
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [[artifactRef]],
    },
  });`,
    ],
    [
      "derived continuation element",
      `const artifactRef = dsl.publishArtifact("intent.md", "intent");
  await dsl.awaitOperator({
    reason: "review required",
    operatorHandoff: {
      title: "Review",
      questions: [{ kind: "text", id: "review", prompt: "What should change?" }],
      continuationArtifactRefs: [\`\${artifactRef}\`],
    },
  });`,
    ],
  ])("rejects an invalid operator handoff artifact use: %s", (_label, body) => {
    expect(
      standardWorkflowSourceShapeErrors(
        standardSource(`export default async function run(dsl) {
  ${body}
  return true;
}`),
      ),
    ).toContain(
      "standard profile forwards opaque semantic, model, file, host, and runtime values only as whole values",
    );
  });

  it("makes a raw request design-review-build and reserves design-only for explicit pauses", () => {
    const author = source(".agents/agents/workflow-author.md");
    expect(author).toContain("tools: read, search, find, write, edit, bash");
    expect(author).toContain("Any plain request to create, design, write, or author a workflow is Author");
    expect(author).toContain("Author performs one continuous sequence");
    expect(author).toMatch(/Never create\s+source before the design/u);
    expect(author).toContain("Only explicit wording such as `Design only`");
    expect(author).toContain("You never run a workflow");
    expect(author).toMatch(/material\s+(?:algorithm\s+)?(?:mismatch|change)/u);

    const authorRoute = author.split("### Author\n")[1]?.split("### Design-only\n")[0] ?? "";
    const designOnlyRoute = author.split("### Design-only\n")[1]?.split("### Revise\n")[0] ?? "";
    const buildRoute = author.split("### Build\n")[1]?.split("## Design method\n")[0] ?? "";
    expect(authorRoute).toContain("then create exactly\nthe declared direct `.workflow.mjs` entries");
    expect(authorRoute).toContain("if it declares `group-only`, it\ncontains no root");
    expect(designOnlyRoute).toContain("must not create or edit a\n`.workflow.mjs`");
    expect(buildRoute).toContain(
      "creates an optional folder-owned root only when\n`Entries` declares a `runnable root`, plus exactly the direct child entries",
    );
    expect(buildRoute).toContain("A `group-only` design creates no root");
    expect(buildRoute).toContain("stops without running");
  });

  it("requires Build to return the exact copyable workflow launch command", () => {
    const author = source(".agents/agents/workflow-author.md");

    expect(author).toContain("/workflows run <name>");
    expect(author).toMatch(/exact copyable launch command/u);
  });

  it("defines an optional runnable root or group-only direct child contract", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain(".pi/workflows/<name>/<name>.design.md");
      expect(text).toContain("runnable root");
      expect(text).toContain("group-only");
      expect(text).toMatch(/<(?:name|root)>\/<child>/u);
      expect(text).toMatch(/## Entries|`Entries` table/u);
      expect(text).toMatch(/direct child|direct sibling/iu);
    }
  });

  it("teaches exact text, choice, and handoffs as the standard answer forms", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain("exact text");
      expect(text).toContain("choice:");
      expect(text).toContain("handoffs:");
      expect(text).toMatch(/raw `schema`|Raw `schema`/u);
      expect(text).toMatch(/advanced compatibility/u);
    }
  });

  it("keeps the source graph visible and rejects hidden orchestration machinery", () => {
    const author = source(".agents/agents/workflow-author.md");
    expect(author).toContain("Keep direct `agent()` calls, prompts, exact text handoffs, branches, and edges");
    for (const smell of [
      "input splitting",
      "JSON/prose parsers",
      "domain validators",
      "render helpers",
      "manual\nretries",
      "branch-local `try/catch`",
      "wrappers around\n`agent()`",
    ]) {
      expect(author).toContain(smell);
    }
  });

  it("keeps semantic input out of hidden branch protocols", () => {
    const skill = source("skills/locus-pi-workflows/SKILL.md");
    const card = source("skills/locus-pi-workflows/references/fixed-fan-out.md");
    expect(skill).toContain("does not encode a hidden");
    expect(skill).toContain("`split`, regex-match, or parse");
    expect(card).toContain("author-known");
    expect(card).toContain("Do not encode them as newline/CSV/JSON");
  });

  it("teaches native caller items as one exact list source for the existing pipeline", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
      "extensions/workflows/references/patterns.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain("dsl.items()");
      expect(text).toContain("pipeline");
    }
    const authoring = source("extensions/workflows/AUTHORING.md");
    expect(authoring).toContain("author-known array");
    expect(authoring).toContain("agent({ handoffs })");
    expect(authoring).toContain("requires at least one work item");
    expect(authoring).not.toContain("requires at least one caller-supplied item");
    expect(authoring).not.toContain("[...items]");
    expect(source("extensions/workflows/REFERENCE.md")).toContain("10,000 physical attempts/run");
  });

  it("omits default per-attempt fuse fields from standard authoring output", () => {
    const standardSnippets = [
      "extensions/workflows/AUTHORING.md",
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/REFERENCE.md",
    ].flatMap((relativePath) => declaredStandardDocSnippets(relativePath));

    for (const snippet of standardSnippets) {
      expect(snippet).not.toMatch(/\b(?:maxToolCalls|timeoutMs)\s*:/u);
    }

    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).toMatch(/omit(?:s)? `maxToolCalls` and `timeoutMs`/iu);
      expect(text).toMatch(/operator explicitly request/u);
      expect(text).toMatch(/narrower\s+or\s+raised/u);
    }

    expect(source("extensions/workflows/references/patterns.md")).not.toMatch(/\b(?:maxToolCalls|timeoutMs)\s*:/u);
  });

  it("uses design-derived handoff bounds instead of a magic authoring limit", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      "skills/locus-pi-workflows/references/dynamic-orchestrator-workers.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).not.toMatch(/maxItems\s*:\s*64/u);
      expect(text).toContain("MAX_DAGS_IN_SCOPE");
      expect(text).toMatch(/transport safety|protects one\s+structured/u);
      expect(text).toMatch(/not\s+a default business limit/u);
      expect(text).toMatch(/1\.\.100|1–100/u);
      expect(text).toMatch(/one\s+repair|repairs\s+one/u);
      expect(text).toMatch(/fail(?:s|ure)?[- ]closed/u);
    }
  });

  it("keeps Plan approval separate from continuous workflow authoring", () => {
    const card = source("skills/locus-pi-workflows/references/plan-to-sequential-workflow.md");
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain("plan.md");
      expect(text).toContain("step-<n>.md");
      expect(text).toMatch(/literal\s+author-known/u);
      expect(text).toMatch(/caller\s+`items`|caller\s+items/u);
      expect(text).toMatch(/Plan approval.*(?:does not start|starts neither)/isu);
    }
    expect(card).toMatch(/one\s+complete task block/u);
    expect(card).toMatch(/visibly\s+separate child/u);
    expect(card).toMatch(/no Locus items count or\s+character policy/u);
    expect(card).not.toMatch(/\bunbounded\b/iu);
    const author = source(".agents/agents/workflow-author.md");
    expect(author).toContain("Each implementer receives exactly one complete task block");
    expect(author).toContain("matching `history/S<n>.md`");
    expect(author).toMatch(/reviewer receives.*separately/isu);
    expect(author).toContain("never add a\nworkflow under `extensions/workflows/examples/`");
  });

  it("links canonical agent, authority, event, and human-unit budget semantics", () => {
    const skill = source("skills/locus-pi-workflows/SKILL.md");
    const author = source(".agents/agents/workflow-author.md");
    const manual = source("extensions/workflows/REFERENCE.md");
    const agentsManual = source("extensions/agents/README.md");

    expect(manual).toContain('agent(prompt, { agent: "default" })');
    expect(manual).toContain("project `.agents/agents/`");
    expect(manual).toContain("`~/.agents/agents/`");
    expect(manual).toContain("package's bundled `.agents/agents/`");
    expect(manual).toContain("full host-exposed tool surface");
    expect(manual).toContain("is not authorization");
    expect(manual).toContain("presentation metadata");
    expect(manual).toContain("`phase()` is the\ncall that journals actual execution");
    expect(manual).toContain("one readable script event");
    for (const text of [skill, author, manual]) {
      expect(text).toMatch(/1,000 (?:tool )?calls/u);
      expect(text).toMatch(/24-hour/u);
      expect(text).toMatch(/20 turns/u);
      expect(text).toMatch(/500,000\s+(?:answer\s+)?characters/u);
      expect(text).toMatch(/10,000\s+physical attempts/u);
      expect(text).toMatch(/four attempts concurrently|concurrency four|4 attempts at once/u);
      expect(text).toMatch(
        /Review.*retry attempts consume|reviewer.*retry.*consume|review.*transport-retry.*consume/isu,
      );
      expect(text).toMatch(/SDK timeout.*later transport backstop/isu);
    }
    expect(agentsManual).toContain("project -> user -> package precedence");
    expect(manual).toContain("no Locus items count or character policy");
  });

  it("keeps ordered stages separate from the caller-item inline mini-workflow pattern", () => {
    const patterns = source("extensions/workflows/references/patterns.md");
    const ordered =
      patterns.split("## Ordered pipeline\n")[1]?.split("## Caller-supplied item mini-workflows\n")[0] ?? "";
    const callerItems =
      patterns.split("## Caller-supplied item mini-workflows\n")[1]?.split("## Fan-out/fan-in\n")[0] ?? "";

    expect(ordered).toContain("extracted: await agent");
    expect(ordered).toContain("classified: await agent");
    expect(callerItems).toContain("const items = dsl.items()");
    expect(callerItems).toContain("dsl.pipeline(items");
    expect(callerItems).toContain("dsl.workflow((nested) => processItem(nested, item))");
    expect(callerItems).toContain("requires caller-supplied items");
  });

  it("ships compact progressive-disclosure cards with the required decision facts", () => {
    const referencesDir = path.join(root, "skills/locus-pi-workflows/references");
    const cards = readdirSync(referencesDir)
      .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
      .sort();
    expect(cards).toEqual([
      "bounded-candidate-search.md",
      "bounded-review-loop.md",
      "dynamic-orchestrator-workers.md",
      "fixed-fan-out.md",
      "human-gate.md",
      "plan-to-sequential-workflow.md",
      "sequential-text.md",
    ]);
    for (const name of cards) {
      const text = source(`skills/locus-pi-workflows/references/${name}`);
      expect(text).toMatch(/Use |Use this card/u);
      expect(text).toMatch(/Avoid |Allowed redesigns/u);
      expect(text).toContain("Graph");
      expect(text).toContain("Cost");
      expect(text).toContain("Handoff");
      expect(text).toContain("Failure");
      expect(text).toMatch(/Primitive|Required primitives/u);
    }
  });

  it("teaches bounded dynamic handoffs without manufacturing a recursive manager", () => {
    const card = source("skills/locus-pi-workflows/references/dynamic-orchestrator-workers.md");
    expect(card).toContain("agent({ handoffs })");
    expect(card).toContain("complete non-blank unique text unit");
    expect(card).toContain("child `spawn_agent`/`task`, which remains unavailable");
    expect(card).toContain("intentionally non-resumable");
    expect(card).toContain("separate caller");
    expect(card).toContain("Never derive resumable positional");
  });

  it("teaches durable saved children, stable primary files, and explicit standard profiles", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain("invokeWorkflow");
      expect(text).toContain("publishPrimaryFile");
      expect(text).toContain("outputDir");
      expect(text).toContain('profile: "standard"');
    }
  });

  it("keeps fresh model discovery outside resumable positional checkpointing", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      "skills/locus-pi-workflows/references/dynamic-orchestrator-workers.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
      "extensions/workflows/REFERENCE.md",
    ]) {
      const text = source(relativePath);
      expect(text).toMatch(/fresh model (?:output|discovery)/iu);
      expect(text).toMatch(/Never\s+derive\s+resumable\s+positional/iu);
      expect(text).toMatch(/exact same|exact list and ordering|frozen/iu);
    }
  });

  it("classifies every existing Package registry entry", () => {
    const profiles = Object.fromEntries(
      packagedWorkflowNames().map((name) => {
        const text = readFileSync(packagedWorkflowPath(name), "utf8");
        return [name, staticWorkflowMeta(text).profile];
      }),
    );

    expect(profiles).toEqual({
      implement: "standard",
      "live-smoke": "standard",
      "task/draft": "standard",
      "task/implement": "standard",
      "task/plan": "standard",
      "task-via-script": "standard",
      "post-code-review": "standard",
      "post-code-review/boundaries": "standard",
      "post-code-review/contracts": "standard",
      "post-code-review/necessity": "standard",
      "post-code-review/scope": "standard",
      "post-code-review/simplicity": "standard",
      "post-code-review/style": "standard",
      "post-code-review/synthesis": "standard",
      "workflow-creator": "standard",
      "workflow-creator/build": "standard",
      "workflow-creator/design": "standard",
      "workflow-creator/svg": "standard",
    });
    expect(packagedWorkflowNames()).toHaveLength(18);
    for (const name of [
      "implement",
      "live-smoke",
      "task/draft",
      "task/implement",
      "task/plan",
      "task-via-script",
      "post-code-review",
      "post-code-review/boundaries",
      "post-code-review/contracts",
      "post-code-review/necessity",
      "post-code-review/scope",
      "post-code-review/simplicity",
      "post-code-review/style",
      "post-code-review/synthesis",
      "workflow-creator",
      "workflow-creator/build",
      "workflow-creator/design",
      "workflow-creator/svg",
    ]) {
      expect(standardWorkflowSourceShapeErrors(readFileSync(packagedWorkflowPath(name), "utf8")), name).toEqual([]);
    }
  });

  it.each([
    [
      "named function entry",
      standardSource(`export default async function runWorkflow(dsl, input) {
  const topic = typeof input === "string" && input.trim() ? input.trim() : "default topic";
  const answer = await dsl.agent(\`Topic: \${topic}. Choose the route.\`, { choice: ["DONE", "BLOCKED"] });
  if (answer === "DONE") dsl.log(answer);
  return { topic, answer };
}`),
    ],
    [
      "arrow entry with visible inline edges",
      standardSource(`export default async (dsl) => {
  const { agent, parallel } = dsl;
  const items = ["one", "two"];
  return parallel(items.map((item) => () => agent(\`Handle \${item}\`)));
};`),
    ],
    [
      "author-known top-level collection",
      standardSource(
        `export default async function run({ agent, parallel }) {
  return parallel(ITEMS.map((item) => () => agent(\`Handle \${item}\`)));
}`,
        'const ITEMS = ["one", "two"];',
      ),
    ],
    [
      "prompt-only collection join",
      standardSource(`export default async function run({ agent, parallel }) {
  const findings = await parallel([() => agent("Inspect one"), () => agent("Inspect two")]);
  return agent(\`Compose these exact findings:\n\${findings.join("\\n\\n")}\`);
}`),
    ],
    [
      "durable item loop with unshadowed Error",
      standardSource(`export default async function runWorkflow(dsl) {
  const items = dsl.items();
  if (items.length === 0) throw new Error("items required");
  const keys = items.map((_, itemIndex) => \`item-\${itemIndex + 1}\`);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await dsl.invokeWorkflow({
      name: "worker",
      key: keys[index],
      keys,
      input: item,
      items: [item],
      outputDir: dsl.outputDir(),
    });
  }
  return dsl.publishPrimaryFile("report.md");
}`),
    ],
    ["literal Error construction", standardSource('export default function run() { throw new Error("stop"); }')],
    ["ordinary acknowledgement result", standardSource('export default () => "WRITTEN";')],
    ["bare DSL arrow parameter", standardSource('export default dsl => dsl.agent("x");')],
    [
      "literal binding names without substring policy",
      standardSource("export default function run() { const checkpointLedger = []; return checkpointLedger; }"),
    ],
    [
      "whole opaque values forwarded to prompts and publication",
      standardSource(`export default async function run({ agent, publishPrimaryArtifact }, input) {
  const answer = await agent(\`Review this exact request: \${input}\`);
  return publishPrimaryArtifact("review.md", answer);
}`),
    ],
    [
      "opaque whole value scheduled inside explicit input and items fields",
      standardSource(`export default async function run({ agent, invokeWorkflow, outputDir }, input) {
  const answer = await agent(input);
  await invokeWorkflow({
    name: "worker",
    key: "one",
    keys: ["one"],
    input: answer,
    items: [answer],
    outputDir: outputDir(),
  });
  return answer;
}`),
    ],
    [
      "direct opaque producer scheduled as an explicit whole input",
      standardSource(`export default async function run({ agent, invokeWorkflow, outputDir }, input) {
  return invokeWorkflow({
    name: "worker",
    key: "one",
    keys: ["one"],
    input: await agent(input),
    items: [input],
    outputDir: outputDir(),
  });
}`),
    ],
    [
      "runtime-owned choice controls a branch",
      standardSource(`export default async function run({ agent }) {
  const route = await agent("Choose a route.", {
    choice: ["accept", "revise"],
    choiceFallback: "revise",
  });
  if (route === "accept") return agent("Handle the accepted route.");
  return agent("Handle the revision route.");
}`),
    ],
    [
      "runtime-owned choice indexes author-known routes",
      standardSource(
        `export default async function run({ agent }) {
  const route = await agent("Choose a route.", { choice: ["deploy", "hold"] });
  return agent(ROUTES[route]);
}`,
        'const ROUTES = { deploy: "Deploy the approved release.", hold: "Hold the release." };',
      ),
    ],
    [
      "inline runtime-owned choice indexes author-known routes",
      standardSource(
        `export default async function run({ agent }) {
  return agent(ROUTES[await agent("Choose a route.", { choice: ["deploy", "hold"] })]);
}`,
        'const ROUTES = { deploy: "Deploy the approved release.", hold: "Hold the release." };',
      ),
    ],
    [
      "nested literal can reuse the semantic input spelling without changing its provenance",
      standardSource(`export default async function run({ agent, log }, input) {
  if (true) {
    const input = "local";
    if (input === "local") log(input);
  }
  return agent(\`Handle this exact request: \${input}\`);
}`),
    ],
    [
      "case-local literal shadow does not mask the outer semantic input",
      standardSource(`export default function run({ agent, log }, input) {
  switch ("local") {
    case "local":
      const input = "local";
      if (input === "local") log(input);
      break;
    default:
      break;
  }
  return agent(input);
}`),
    ],
    [
      "default-local literal shadow does not mask the outer semantic input",
      standardSource(`export default function run({ agent, log }, input) {
  switch ("other") {
    case "local":
      break;
    default:
      const input = "local";
      log(input);
  }
  return agent(input);
}`),
    ],
    [
      "runtime-owned list identity and unchanged map items",
      standardSource(`export default async function run({ agent, parallel }) {
  const units = await agent("Return work units.", { handoffs: { maxItems: 8 } });
  if (units.length === 0) return [];
  return parallel(units.map((item) => () => agent(\`Handle this exact item: \${item}\`)));
}`),
    ],
    [
      "pipeline stages forward opaque values and use runtime indexes",
      standardSource(`export default async function run({ agent, pipeline }) {
  const plans = ["one", "two"];
  return pipeline(
    plans,
    (plan, planIndex) => agent(\`Draft \${planIndex}: \${plan}\`),
    (draft, reviewIndex) => agent(\`Review \${reviewIndex}: \${draft}\`),
  );
}`),
    ],
    [
      "known collection map classifies item index and whole array",
      standardSource(`export default async function run({ agent, parallel }) {
  const plans = ["one", "two"];
  return parallel(plans.map((plan, planIndex, allPlans) => () =>
    agent(\`Plan \${planIndex + 1} of \${allPlans.length}: \${plan}\`),
  ));
}`),
    ],
    [
      "runtime-owned saved-call status controls a branch",
      standardSource(`export default async function run({ agent, invokeWorkflow }) {
  const child = await invokeWorkflow({ name: "worker", key: "item-1", keys: ["item-1"] });
  if (child.status === "completed") return agent("Continue after the completed child.");
  return agent("Report the non-completed child status.");
}`),
    ],
    [
      "opaque for-of item forwarded unchanged",
      standardSource(`export default async function run({ agent, items }) {
  for (const item of items()) await agent(\`Handle this exact item: \${item}\`);
  return true;
}`),
    ],
    [
      "bound opaque for-of list stays structural while each item remains opaque",
      standardSource(`export default async function run({ agent, items }) {
  const workItems = items();
  for (const workItem of workItems) await agent(\`Handle this exact item: \${workItem}\`);
  return true;
}`),
    ],
    [
      "declared literal roots and object property names remain available",
      standardSource(
        `export default function run({ agent }) {
  const box = { route: "deploy" };
  if (box.route === ROUTES.deploy) return agent("Deploy");
  return agent("Hold");
}`,
        'const ROUTES = { deploy: "deploy" };',
      ),
    ],
    [
      "first run parameter supplies DSL trust",
      standardSource("export default function run({ log }, input) { log(input); }"),
    ],
    [
      "discarded acknowledgement prompt remains structural JavaScript",
      standardSource(
        'export default async function run({ agent }) { await agent("Reply exactly DONE"); return true; }',
      ),
    ],
  ])("accepts %s in the standard source grammar", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toEqual([]);
  });

  it.each([
    [
      "unlisted semantic method",
      standardSource("export default function run(dsl, input) { return input.toUpperCase(); }"),
    ],
    [
      "function-valued IIFE",
      standardSource('export default function run(dsl, input) { return (() => input.replaceAll("old", "new"))(); }'),
    ],
    [
      "global report renderer",
      standardSource("export default function run(dsl, input) { return JSON.stringify({ report: input }); }"),
    ],
    [
      "unknown global call",
      standardSource("export default function run(dsl, input) { return encodeURIComponent(input); }"),
    ],
    ["unbound DSL-shaped global", standardSource('export default function run() { return dsl.agent("x"); }')],
    [
      "manual parser/renderer loop",
      standardSource(`export default function run(dsl, input) {
  const characters = [];
  for (const character of input) characters.push(character);
  return characters.join("");
}`),
    ],
    [
      "bound agent alias",
      standardSource(
        'export default function run(dsl) { const callWorker = dsl.agent.bind(dsl); return callWorker("x"); }',
      ),
    ],
  ])("rejects reviewer false-green: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "switch-scoped agent renderer",
      standardSource(`export default function run({ agent }, input) {
  switch (input) {
    default: {
      const agent = JSON.stringify;
      return agent({ report: input });
    }
  }
}`),
    ],
    [
      "switch-scoped dsl object",
      standardSource(`export default function run(dsl, input) {
  switch (input) {
    default: {
      const dsl = { agent: JSON.stringify };
      return dsl.agent({ report: input });
    }
  }
}`),
    ],
    [
      "for-of log eval",
      standardSource(`export default function run({ log }, input) {
  for (const log of [eval]) return log(input);
}`),
    ],
    [
      "for-of Error Function",
      standardSource(`export default function run(dsl, input) {
  for (const Error of [Function]) return new Error(input);
}`),
    ],
  ])("rejects reviewer lexical-shadow probe: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "bare log callback parameter",
      standardSource(`export default function run({ log }, input) {
  return [eval].map(log => log(input));
}`),
    ],
    [
      "bare agent callback parameter",
      standardSource(`export default function run({ agent, parallel }, input) {
  return parallel([eval].map(agent => agent(input)));
}`),
    ],
    [
      "bare Error callback parameter",
      standardSource(`export default function run(dsl, input) {
  return [Function].map(Error => new Error(input));
}`),
    ],
    [
      "bare collection callback parameter",
      standardSource(`export default function run({ pipeline, items }, input) {
  return pipeline(items(), agent => agent(input));
}`),
    ],
  ])("rejects reviewer bare-arrow shadow probe: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "plain agent text comparison",
      standardSource(`export default async function run({ agent }) {
  const answer = await agent("Return prose");
  if (answer === "approved") return agent("Take approved path");
}`),
    ],
    [
      "plain agent text length inspection",
      standardSource(`export default async function run({ agent, log }) {
  const answer = await agent("Return prose");
  if (answer.length > 80) log("long");
}`),
    ],
    [
      "semantic input branch",
      standardSource(
        'export default function run({ agent }, input) { return input === "deploy" ? agent("Deploy") : agent("Do not deploy"); }',
      ),
    ],
    [
      "opaque item renaming",
      standardSource("export default function run({ items }) { return items().map((item) => `task-${item}`); }"),
    ],
    [
      "plain agent text report rendering",
      standardSource(`export default async function run({ agent }) {
  const answer = await agent("Return findings");
  return { report: \`# Findings\\n\\n\${answer}\` };
}`),
    ],
    [
      "opaque for-of item destructuring",
      standardSource(`export default async function run({ agent, items }) {
  for (const { task } of items()) await agent(task);
  return true;
}`),
    ],
  ])("rejects opaque-value architecture violation: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "semantic input as author-known route subscript",
      standardSource(
        "export default function run({ agent }, input) { return agent(ROUTES[input]); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "plain agent answer as author-known route subscript",
      standardSource(
        `export default async function run({ agent }) {
  const answer = await agent("Return prose.");
  return agent(NEXT[answer]);
}`,
        'const NEXT = { done: "Finish", revise: "Revise" };',
      ),
    ],
    [
      "semantic input as array index",
      standardSource(
        "export default function run({ agent }, input) { return agent(ROUTES[input]); }",
        'const ROUTES = ["Deploy", "Hold"];',
      ),
    ],
    [
      "semantic input hidden inside a nested template subscript",
      standardSource(
        "export default function run({ agent }, input) { return agent(`Please ${TONE[input]}.`); }",
        'const TONE = { calm: "stay calm" };',
      ),
    ],
  ])("rejects opaque sink intermediary: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "direct plain-agent result as route index",
      standardSource(
        "export default async function run({ agent }, input) { return agent(ROUTES[await agent(input)]); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct caller item as route index",
      standardSource(
        "export default function run({ agent, items }) { return agent(ROUTES[items()[0]]); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct consumed artifact as route index",
      standardSource(
        'export default function run({ agent, consumeTextArtifact }) { return agent(ROUTES[consumeTextArtifact("x")]); }',
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct opaque producer nested in template route",
      standardSource(
        "export default async function run({ agent }, input) { return agent(`Next: ${ROUTES[await agent(input)]}`); }",
        'const ROUTES = { deploy: "Deploy", hold: "Hold" };',
      ),
    ],
    [
      "direct opaque producer nested in concatenated route index",
      standardSource(
        'export default async function run({ agent }, input) { return agent(ROUTES["route-" + await agent(input)]); }',
        'const ROUTES = { "route-deploy": "Deploy", "route-hold": "Hold" };',
      ),
    ],
  ])("rejects opaque provenance anywhere in a subscript index: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "pipeline first-stage opaque branch",
      standardSource(`export default function run({ agent, items, pipeline }) {
  return pipeline(items(), (item) => agent(item === "deploy" ? "Deploy" : "Hold"));
}`),
    ],
    [
      "pipeline later-stage plain-text measurement",
      standardSource(`export default function run({ agent, pipeline }) {
  const plans = ["one"];
  return pipeline(
    plans,
    (plan) => agent(plan),
    (draft) => agent(draft.length > 100 ? "Shorten" : "Expand"),
  );
}`),
    ],
    [
      "opaque map whole-array parameter branch",
      standardSource(`export default function run({ agent, items, parallel }) {
  const list = items();
  return parallel(list.map((item, itemIndex, allItems) => () =>
    agent(allItems[0] === "deploy" ? item : \`Hold \${itemIndex}\`),
  ));
}`),
    ],
    [
      "opaque identity map laundering",
      standardSource(`export default function run({ agent, items }) {
  const clean = items().map((item) => { return item; });
  for (const candidate of clean) {
    if (candidate === "deploy") return agent("Deploy");
  }
  return agent("Hold");
}`),
    ],
    [
      "unclassified callback parameter",
      standardSource(`export default function run({ agent, parallel }) {
  return parallel([(hidden) => agent(hidden)]);
}`),
    ],
  ])("rejects unclassified or transformed callback values: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "run semantic input through arguments",
      standardSource(`export default function run({ agent }, input) {
  if (arguments[1] === "deploy") return agent("Deploy");
  return agent(input);
}`),
    ],
    [
      "map item through arguments",
      standardSource(`export default function run({ agent, items, parallel }) {
  return parallel(items().map(function () {
    return () => agent(arguments[0] === "deploy" ? "Deploy" : "Hold");
  }));
}`),
    ],
    [
      "map index through arguments",
      standardSource(`export default function run({ agent, items, parallel }) {
  return parallel(items().map(function () {
    return () => agent(arguments[1] > 0 ? "Later" : "First");
  }));
}`),
    ],
    [
      "map whole array through arguments",
      standardSource(`export default function run({ agent, items, parallel }) {
  return parallel(items().map(function () {
    return () => agent(arguments[2][0] === "deploy" ? "Deploy" : "Hold");
  }));
}`),
    ],
    [
      "pipeline value through arguments",
      standardSource(`export default function run({ agent, items, pipeline }) {
  return pipeline(items(), function () {
    return agent(arguments[0] === "deploy" ? "Deploy" : "Hold");
  });
}`),
    ],
  ])("rejects implicit arguments channel: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain(
      "standard profile does not use the implicit arguments object",
    );
  });

  it.each([
    [
      "process name followed by an outer process read",
      standardSource(
        `export default async function run({ agent, parallel }) {
  await parallel(KNOWN.map(function process(item) {
    return () => agent(item);
  }));
  if (process.env.DEPLOY === "yes") return agent("Deploy");
  return agent("Hold");
}`,
        'const KNOWN = ["one"];',
      ),
    ],
    [
      "Buffer name followed by an outer Buffer read",
      standardSource(
        `export default async function run({ agent, parallel }) {
  await parallel(KNOWN.map(function Buffer(item) {
    return () => agent(item);
  }));
  if (Buffer.poolSize > 0) return agent("Deploy");
  return agent("Hold");
}`,
        'const KNOWN = ["one"];',
      ),
    ],
  ])("rejects named callback ambient-root leakage: %s", (_label, text) => {
    const errors = standardWorkflowSourceShapeErrors(text);
    expect(errors).toContain("standard profile uses arrow functions for inline callbacks");
    expect(errors).toContain(
      "standard profile reads values only from declared lexical bindings and approved language roots",
    );
  });

  it("keeps a named function-expression name local while rejecting the callback form", () => {
    const text = standardSource(
      `export default function run({ agent, parallel }) {
  return parallel(KNOWN.map(function process(item) {
    if (process) return () => agent(item);
    return () => agent(item);
  }));
}`,
      'const KNOWN = ["one"];',
    );
    const errors = standardWorkflowSourceShapeErrors(text);
    expect(errors).toContain("standard profile uses arrow functions for inline callbacks");
    expect(errors).not.toContain(
      "standard profile reads values only from declared lexical bindings and approved language roots",
    );
  });

  it.each([
    [
      "opaque scalar",
      standardSource(`export default async function run({ agent }, input) {
  const answer = (0, await agent(input));
  if (answer === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque value inside an array",
      standardSource(`export default async function run({ agent }, input) {
  const copied = [(0, await agent(input))];
  if (copied[0] === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque value inside an object",
      standardSource(`export default async function run({ agent }, input) {
  const box = { value: (0, await agent(input)) };
  if (box.value === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "nested composite result",
      standardSource(`export default async function run({ agent }, input) {
  const copied = ((["known"]), [await agent(input)]);
  if (copied[0] === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "literal-only sequence",
      standardSource(`export default function run({ agent }) {
  const known = (1, 2);
  if (known === 2) return agent("Deploy");
  return agent("Hold");
}`),
    ],
  ])("rejects every sequence expression: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain("standard profile uses no sequence expressions");
  });

  it.each([
    [
      "direct opaque scalar",
      standardSource(`export default async function run({ agent }, input) {
  return new Error(await agent(input));
}`),
    ],
    [
      "Error message inspection",
      standardSource(`export default async function run({ agent }, input) {
  const answer = new Error(await agent(input));
  if (answer.message === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque array spread",
      standardSource(`export default function run({ items }) {
  throw new Error("stop", { cause: [...items()] });
}`),
    ],
    [
      "nested cause and options",
      standardSource(`export default async function run({ agent }, input) {
  throw new Error("stop", { cause: { details: [await agent(input)] } });
}`),
    ],
    [
      "member extraction from opaque text",
      standardSource(`export default async function run({ agent }, input) {
  const answer = await agent(input);
  throw new Error(answer.message);
}`),
    ],
  ])("rejects runtime provenance inside Error arguments: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain(
      "standard profile constructs Error only from author-known or literal values",
    );
  });

  it.each([
    [
      "opaque list spread into a new array",
      standardSource(`export default function run({ agent, items }) {
  const copied = [...items()];
  for (const candidate of copied) if (candidate === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "direct plain-agent result in an array",
      standardSource(`export default async function run({ agent }, input) {
  const copied = [await agent(input)];
  if (copied[0] === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "direct plain-agent result in an object",
      standardSource(`export default async function run({ agent }, input) {
  const box = { value: await agent(input) };
  if (box.value === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "direct runtime choice laundered through an object",
      standardSource(`export default async function run({ agent }) {
  const box = { route: await agent("Route?", { choice: ["deploy", "hold"] }) };
  if (box.route === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "opaque producer nested through objects arrays and spread",
      standardSource(`export default async function run({ agent }, input) {
  const nested = { rows: [...[{ value: await agent(input) }]] };
  if (nested.rows[0].value === "deploy") return agent("Deploy");
  return agent("Hold");
}`),
    ],
  ])("rejects composite provenance laundering: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "process environment",
      standardSource(`export default function run({ agent }) {
  if (process.env.DEPLOY === "yes") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "globalThis computed process",
      standardSource(`export default function run({ agent }) {
  if (globalThis["process"]["env"]["DEPLOY"] === "yes") return agent("Deploy");
  return agent("Hold");
}`),
    ],
    [
      "Buffer ambient value",
      standardSource(
        'export default function run({ agent }) { return agent(Buffer.byteLength("deploy") ? "Deploy" : "Hold"); }',
      ),
    ],
    [
      "arbitrary undeclared value",
      standardSource(
        'export default function run({ agent }) { return mystery === "deploy" ? agent("Deploy") : agent("Hold"); }',
      ),
    ],
    [
      "undeclared shorthand object value",
      standardSource("export default function run({ agent }) { const box = { mystery }; return agent(box); }"),
    ],
    [
      "implicit this value root",
      standardSource(
        'export default function run({ agent }) { return this?.deploy ? agent("Deploy") : agent("Hold"); }',
      ),
    ],
  ])("rejects undeclared ambient value root: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).toContain(
      "standard profile reads values only from declared lexical bindings and approved language roots",
    );
  });

  it.each([
    [
      "case literal shadow followed by outer opaque branch",
      standardSource(`export default function run({ agent, log }, input) {
  switch ("local") {
    case "local":
      const input = "local";
      if (input === "local") log(input);
      break;
    default:
      break;
  }
  if (input === "deploy") return agent("Deploy");
  return input;
}`),
    ],
    [
      "default literal shadow followed by outer opaque rendering",
      standardSource(`export default function run({ log }, input) {
  switch ("other") {
    case "local":
      break;
    default:
      const input = "local";
      log(input);
  }
  return \`semantic:\${input}\`;
}`),
    ],
  ])("rejects outer opaque use after switch-local literal: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "inner choice reuses semantic input",
      standardSource(`export default async function run({ agent }, input) {
  if (true) {
    const input = await agent("Choose.", { choice: ["deploy", "hold"] });
    await agent(ROUTES[input]);
  }
  if (input === "deploy") return agent("Deploy");
}`),
    ],
    [
      "loop counter reuses semantic input",
      standardSource(`export default function run({ agent }, input) {
  for (let input = 0; input < 1; input += 1) agent("Tick");
  if (input === "deploy") return agent("Deploy");
}`),
    ],
    [
      "handoff list reuses semantic input",
      standardSource(`export default async function run({ agent }, input) {
  if (true) {
    const input = await agent("Return units.", { handoffs: { maxItems: 2 } });
    await agent(\`Units: \${input.join("\\n")}\`);
  }
  if (input.length > 0) return agent("Deploy");
}`),
    ],
    [
      "saved-call status reuses semantic input",
      standardSource(`export default async function run({ agent, invokeWorkflow }, input) {
  if (true) {
    const input = await invokeWorkflow({ name: "worker", key: "one", keys: ["one"] });
    if (input.status === "completed") await agent("Done");
  }
  if (input.status === "completed") return agent("Deploy");
}`),
    ],
    [
      "map index reuses semantic input",
      standardSource(`export default function run({ agent }, input) {
  ["one"].map((item, input) => agent(\`\${input}: \${item}\`));
  if (input === "deploy") return agent("Deploy");
}`),
    ],
  ])("rejects duplicate value-bearing scope collision: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "trusted assignment in for increment",
      standardSource(`export default function run({ log }, input) {
  for (let index = 0; log !== eval; log = eval) {}
  return log(input);
}`),
    ],
    [
      "trusted destructuring assignment in for increment",
      standardSource(`export default function run({ agent }) {
  for (let index = 0; index < 1; [agent] = [eval]) {}
  return agent("x");
}`),
    ],
    [
      "second run parameter masquerading as DSL",
      standardSource('export default function run({ log }, { agent }) { return agent("payload"); }'),
    ],
  ])("rejects trusted binding provenance violation: %s", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it.each([
    [
      "mutable profile metadata",
      'export let meta = { name: "contract-test", profile: "standard", description: "Contract test." };\nexport default function run() {}',
    ],
    ["Node imports", standardSource("export default function run() {}", 'import fs from "node:fs";')],
    ["Node re-exports", standardSource("export default function run() {}", 'export { readFile } from "node:fs";')],
    ["dynamic imports", standardSource('export default function run() { return import("node:fs"); }')],
    ["semantic split", standardSource('export default function run(dsl, input) { return input.split("\\n"); }')],
    ["semantic trim", standardSource("export default function run(dsl, input) { return input.trim(); }")],
    [
      "aliased transform",
      standardSource("export default function run(dsl, input) { const clean = input.trim; return clean(); }"),
    ],
    ["computed transform", standardSource('export default function run(dsl, input) { return input["trim"](); }')],
    ["domain schemas", standardSource('export default function run(dsl) { return dsl.agent("x", { schema: {} }); }')],
    [
      "nested wrappers",
      standardSource(
        'export default function run(dsl) { function callWorker() { return dsl.agent("x"); } return callWorker(); }',
      ),
    ],
    [
      "variable wrappers",
      standardSource(
        'export default function run(dsl) { const callWorker = () => dsl.agent("x"); return callWorker(); }',
      ),
    ],
    [
      "object wrappers",
      standardSource(
        'export default function run(dsl) { const workers = { call: () => dsl.agent("x") }; return workers.call(); }',
      ),
    ],
    [
      "class wrappers",
      standardSource(
        'export default function run(dsl) { class Worker { call() { return dsl.agent("x"); } } return new Worker().call(); }',
      ),
    ],
    [
      "aliased agent calls",
      standardSource('export default function run(dsl) { const callWorker = dsl.agent; return callWorker("x"); }'),
    ],
    ["computed agent calls", standardSource('export default function run(dsl) { return dsl["agent"]("x"); }')],
    [
      "custom recovery",
      standardSource(
        'export default async function run(dsl) { try { return await dsl.agent("x"); } catch { return "fallback"; } }',
      ),
    ],
  ])("rejects %s from the standard source grammar", (_label, text) => {
    expect(standardWorkflowSourceShapeErrors(text)).not.toEqual([]);
  });

  it("reviews every paid bounded-loop revision and reports truthful call cost", () => {
    const card = source("skills/locus-pi-workflows/references/bounded-review-loop.md");
    expect(card).toContain("maximum\nis `1 + 2R + (R - 1) = 3R` calls");
    expect(card).toContain("every paid revision is reviewed");
    expect(card.indexOf("if (round === MAX_REVIEWS) break;")).toBeLessThan(
      card.indexOf("document = await agent(`Return a complete revision"),
    );
  });

  it("ships Workflow Creator as three source-bound reviewed children without executing generated source", () => {
    const root = source("extensions/workflows/examples/workflow-creator/workflow-creator.workflow.mjs");
    const childNames = [...root.matchAll(/\bchild:\s*"([^"]+)"/gu)].map((match) => match[1]);
    expect(childNames).toEqual(["design", "svg", "build"]);
    expect(root).toContain('const CHILD_KEYS = ["design", "svg", "build"]');
    expect(root).toContain('publishPrimaryFile("workflow-package.md")');

    for (const child of ["design", "svg", "build"] as const) {
      const childSource = source(`extensions/workflows/examples/workflow-creator/${child}.workflow.mjs`);
      expect(childSource.match(/choice:\s*\["accept",\s*"revise"\]/gu)).toHaveLength(2);
      expect(childSource).toContain("review limit reached without acceptance");
      expect(childSource).not.toMatch(/\bdsl\.invokeWorkflow\(/u);
    }

    const build = source("extensions/workflows/examples/workflow-creator/build.workflow.mjs");
    expect(build).toContain("Never execute any generated workflow");
    expect(build).toContain("check-workflow-source");
    expect(build).toContain('publishPrimaryFile("workflow-package.md")');
  });
});
