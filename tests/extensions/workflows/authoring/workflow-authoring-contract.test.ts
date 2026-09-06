import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { staticWorkflowMeta } from "../../../../extensions/workflows/catalog/workflow-catalog.js";
import { standardWorkflowSourceShapeErrors } from "../../../../extensions/workflows/tool/workflow-source-shape.js";
import {
  packagedWorkflowNames,
  packagedWorkflowPath,
} from "../../../../extensions/workflows/runtime/workflow-runner.js";

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
    "skills/locus-pi-workflow-create/SKILL.md",
    "extensions/workflows/AUTHORING.md",
    "extensions/workflows/REFERENCE.md",
    "extensions/workflows/tool/workflow-tool.ts",
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

  it("documents the draft to concrete workflow source contract", () => {
    const text = source("extensions/workflows/examples/task/README.md");
    expect(text).toContain("`task` is a group-only Package namespace");
    expect(text).toContain("`task/draft` turns a raw request into `draft.md`");
    expect(text).toContain("Copy and edit this text when needed");
    expect(text).toContain("`task/plan` receives the complete accepted draft as semantic input");
    expect(text).toContain("one concrete `workflow.mjs`");
    expect(text).toContain("Nothing executes the generated workflow automatically");
  });

  it("keeps CLI syntax target-first on every active manual speaker", () => {
    const canonical =
      "/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]";
    for (const relativePath of [
      "skills/locus-pi-workflow-run/SKILL.md",
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
    "skills/locus-pi-workflow-create/SKILL.md",
    "extensions/workflows/AUTHORING.md",
    "extensions/workflows/REFERENCE.md",
  ])("publishes the runnable standard source gate on %s", (relativePath) => {
    expect(source(relativePath)).toContain("workflow_check_source");
  });

  it("makes workflow authoring source-checking fail closed through the Pi-native tool", () => {
    const text = source("skills/locus-pi-workflow-create/SKILL.md");
    expect(text).toContain("workflow_check_source");
    expect(text).toMatch(/(?:unavailable tool|failed checker result)/iu);
    expect(text).toMatch(/never (?:report|return).*successful Build/isu);
  });

  it("keeps the manual hello-world inside the enforced input-normalization grammar", () => {
    expect(source("extensions/workflows/REFERENCE.md")).toContain(
      'const task = typeof input === "string" && input.trim() ? input.trim() : "list the cwd";',
    );
  });

  it("runs every public declared-standard documentation snippet through the source checker", () => {
    const documents = [
      "extensions/workflows/AUTHORING.md",
      "skills/locus-pi-workflow-create/SKILL.md",
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
      "skills/locus-pi-workflow-create/SKILL.md",
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
    for (const relativePath of ["extensions/workflows/AUTHORING.md", "docs/workflows.md"]) {
      const text = source(relativePath);
      expect(text).toContain(".locus-pi/workspaces/<generated-run-name>");
      expect(text).not.toContain("outputs/<workflow-name>");
    }
    expect(source("skills/locus-pi-workflow-create/SKILL.md")).not.toContain(
      ".locus-pi/workspaces/<generated-run-name>",
    );
    const storage = source("docs/workflows.md");
    expect(storage).toContain("runs/<storageRootRunId>/");
    expect(storage).toContain("outputs/    human-readable host projection");
    expect(storage).toContain("runtime/    machine evidence and continuation authority");
    expect(storage).toContain("children/<runId>/");
    expect(storage).toContain("attempts/<runId>/");
    expect(storage).toContain("must never resolve to the same directory");
  });

  it("checks canonical AUTHORING fragments while keeping the installed router code-free", () => {
    const authoring = javascriptDocSnippets("extensions/workflows/AUTHORING.md");
    const skill = javascriptDocSnippets("skills/locus-pi-workflow-create/SKILL.md");
    expect(authoring).toHaveLength(5);
    expect(skill).toHaveLength(0); // Entrypoint routes to tested complete examples; it duplicates no harness.

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
    ];
    for (const fragment of fragments) {
      expect(standardWorkflowSourceShapeErrors(fragment.source), fragment.label).toEqual([]);
    }
  });

  it("keeps unused acknowledgement protocols review-owned instead of parsing prompt English", () => {
    for (const relativePath of ["extensions/workflows/AUTHORING.md", "extensions/workflows/REFERENCE.md"]) {
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

  it("routes one continuous Design-review-Build process without copying the runtime manual", () => {
    const router = source("skills/locus-pi-workflow-create/SKILL.md");
    const design = source("skills/locus-pi-workflow-create/references/design-and-build.md");
    expect(router).toContain("This skill owns authoring only.");
    expect(router).toContain("references/design-and-build.md");
    expect(router).toContain("AUTHORING.md#machine-enforced-standard-source-shape");
    expect(router).toContain("REFERENCE.md");
    expect(router).toContain("Build does not run");
    expect(router).toContain("exact copyable launch command");
    expect(router).toContain("/workflows run <name>");
    expect(router.split("\n").length).toBeLessThan(100);
    expect(design).toContain("before any source");
    expect(design).toContain("## Entries");
    expect(design).toContain("group-only");
    expect(design).toContain("<name>/<child>");
    expect(design).toContain("workflow_check_source");
    expect(design).toContain("material algorithm mismatch");
  });

  it("keeps source grammar, labels, output and failure authority in canonical references", () => {
    const authoring = source("extensions/workflows/AUTHORING.md");
    const manual = source("extensions/workflows/REFERENCE.md");
    const output = source("extensions/workflows/references/output-acceptance.md");
    expect(authoring).toContain("exact text");
    expect(authoring).toContain("choice:");
    expect(authoring).toContain("handoffs:");
    expect(authoring).toContain("literal `label`");
    expect(authoring).toContain("provenance");
    expect(authoring).toContain("Markdown/table/report renderers");
    expect(authoring).toContain("raw `schema`");
    expect(authoring).toContain("dsl.items()");
    expect(manual).toContain("10,000 physical attempts/run");
    expect(manual).toContain("output-acceptance.md");
    expect(manual).toContain("execution-controls.md");
    expect(manual).toContain("recovery-and-continuation.md");
    expect(output).toContain("returnVia");
    expect(output).toContain("workflow_return");
    expect(output).toContain("same");
    expect(output).toContain("fallback");
  });

  it("keeps workflow-create snippets free of file parsing and default fuse boilerplate", () => {
    const authoredDocs = [
      "skills/locus-pi-workflow-create/SKILL.md",
      ...readdirSync(path.join(root, "skills/locus-pi-workflow-create/references"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `skills/locus-pi-workflow-create/references/${name}`),
    ];
    for (const relativePath of authoredDocs) {
      for (const snippet of javascriptDocSnippets(relativePath)) {
        expect(snippet, relativePath).not.toMatch(
          /\b(?:consumeTextArtifact|projectRoot|promptFile|publishPrimaryFile|workspace|now|random)\s*\(/u,
        );
        expect(snippet, relativePath).not.toMatch(/\b(?:maxToolCalls|timeoutMs)\s*:/u);
      }
    }
    const card = source("skills/locus-pi-workflow-create/references/fixed-graph.md");
    expect(card).toContain("author-known");
    expect(card).toContain("do not encode them as newline/CSV/JSON");
    const human = source("skills/locus-pi-workflow-create/references/human-continuation.md");
    expect(human).toContain("integration/compatibility");
    expect(human).toContain("Do not label that example standard");
  });

  it("keeps unchanged defaults and legacy handoff limits in the runtime owner, not the router", () => {
    const manual = source("extensions/workflows/REFERENCE.md");
    expect(manual).toContain("MAX_DAGS_IN_SCOPE");
    expect(manual).toMatch(/1\.\.100|1–100/u);
    expect(manual).toMatch(/1,000 (?:tool )?calls/u);
    expect(manual).toMatch(/24-hour/u);
    expect(manual).toMatch(/20 turns/u);
    expect(manual).toMatch(/500,000\s+(?:answer\s+)?characters/u);
    expect(manual).toMatch(/SDK timeout.*later transport backstop/isu);
    expect(source("skills/locus-pi-workflow-create/SKILL.md")).not.toContain("10,000");
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

  it("ships four pattern cards and keeps legacy names as redirects, not conflicting recipes", () => {
    const base = "skills/locus-pi-workflow-create/references";
    const cards = ["fixed-graph.md", "bounded-refinement.md", "decomposition.md", "human-continuation.md"];
    const index = source(`${base}/INDEX.md`);
    for (const name of cards) {
      expect(index).toContain(name);
      const text = source(`${base}/${name}`);
      for (const word of ["Use", "Avoid", "Graph", "Cost", "Handoff", "Failure", "Primitives"])
        expect(text, name).toContain(word);
      expect(text).toContain(".workflow.mjs");
    }
    for (const name of [
      "sequential-text",
      "fixed-fan-out",
      "bounded-review-loop",
      "bounded-candidate-search",
      "dynamic-orchestrator-workers",
      "human-gate",
    ]) {
      const text = source(`${base}/${name}.md`);
      expect(text.split("\n").length).toBeLessThan(12);
      expect(text).not.toContain("```js");
    }
  });

  it("distinguishes recorded discovery replay from unsafe rediscovered checkpoint identity", () => {
    const card = source("skills/locus-pi-workflow-create/references/decomposition.md");
    expect(card).toContain("agent({ handoffs })");
    expect(card).toContain("complete non-blank unique text unit");
    expect(card).toContain("prefix");
    expect(card).toContain("keys");
    expect(card).not.toContain("intentionally non-resumable");
    expect(source("extensions/workflows/AUTHORING.md")).toContain("Never derive resumable positional");
  });

  it("classifies every existing Package registry entry", () => {
    const profiles = Object.fromEntries(
      packagedWorkflowNames().map((name) => {
        const text = readFileSync(packagedWorkflowPath(name), "utf8");
        return [name, staticWorkflowMeta(text).profile];
      }),
    );

    expect(profiles).toEqual({
      "live-smoke": "standard",
      "task/draft": "standard",
      "task/plan": "standard",
      "post-code-review": "standard",
      "post-code-review/boundaries": "standard",
      "post-code-review/contracts": "standard",
      "post-code-review/necessity": "standard",
      "post-code-review/scope": "standard",
      "post-code-review/simplicity": "standard",
      "post-code-review/style": "standard",
      "post-code-review/synthesis": "standard",
    });
    expect(packagedWorkflowNames()).toHaveLength(11);
    for (const name of [
      "live-smoke",
      "task/draft",
      "task/plan",
      "post-code-review",
      "post-code-review/boundaries",
      "post-code-review/contracts",
      "post-code-review/necessity",
      "post-code-review/scope",
      "post-code-review/simplicity",
      "post-code-review/style",
      "post-code-review/synthesis",
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

  it("reviews every paid revision and reports cap/no-progress without a final unreviewed worker", () => {
    const card = source("skills/locus-pi-workflow-create/references/bounded-refinement.md");
    const example = source("extensions/workflows/references/examples/refinement.workflow.mjs");
    expect(card).toContain("3R");
    expect(card).toContain("cap/no-progress");
    expect(card).toContain("returnVia");
    expect(example).toContain('summary: "round_cap"');
    expect(example).toContain('summary: "no_progress"');
    expect(example.indexOf('label: "worker"')).toBeLessThan(example.indexOf('label: "reviewer"'));
    expect(example.indexOf('label: "reviewer"')).toBeLessThan(example.indexOf('route === "complete"'));
    expect((example.match(/label: "worker"/gu) ?? []).length).toBe(1);
  });
});
