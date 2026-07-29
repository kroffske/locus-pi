import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowArtifactStore } from "../../../extensions/_shared/workflow-artifacts.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

/**
 * T-130 W6/W7 — the consilium reference.
 *
 * Driven with a fake agent runner, so what is proven here is the SHAPE: four stages,
 * three independent advisors, a verifier that is a fresh reader rather than a vote
 * count, and a terminal document that exists on `accept` and does not exist on
 * `reject`. Whether a weak model can complete each stage is a different question, and
 * only a live run answers it (W10).
 */

const workflowDir = path.join(process.cwd(), "extensions/workflows/references/consilium");
const workflowPath = path.join(workflowDir, "consilium.workflow.mjs");
const FIXTURE_QUESTION = readFileSync(path.join(workflowDir, "fixture-question.md"), "utf8").trim();

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as { default?: (dsl: unknown, input?: unknown) => Promise<unknown> };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function completed(request: WorkflowAgentRequest, text: string): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary: text,
    text,
    diagnostics: [],
    agent: request.agent,
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

let ordinal = 0;

function runtimeWith(runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>) {
  const root = mkdtempSync(path.join(tmpdir(), "locus-consilium-"));
  const runId = `consilium-test-${++ordinal}`;
  const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const artifactStore = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
  return {
    root,
    runId,
    artifactStore,
    ...createWorkflowRuntime({ runId, projectRoot: root, artifactPorts: artifactStore, agentRunner: runner }),
  };
}

const SYNTHESIS = [
  "## Answer",
  "Shell out to separate executables, unless the team can afford to own an API.",
  "",
  "## What is settled",
  "The evidence advisor established that half the extensions come from outside the team.",
  "",
  "## Where they disagree",
  "The alternative advisor argues an in-process plugin system wins once the tool needs",
  "to pass rich objects; the risk advisor holds that the versioning cost dominates.",
  "",
  "## What would change the answer",
  "Whether outside authors are willing to depend on the tool's internal types.",
].join("\n");

const ADVICE: Record<string, string> = {
  "evidence advisor": "## Presuppositions\nHalf the extensions come from outside the team.",
  "risk advisor": "## Most likely failure\nThe plugin API becomes a versioning liability.",
  "alternative advisor": "## The alternative\nAn in-process plugin system, because rich objects cross the seam.",
};

/** Answer every stage; the verifier's verdict is the one thing a case varies. */
function stageAnswers(verdict: "accept" | "reject", reason: string) {
  return (request: WorkflowAgentRequest): string => {
    const label = request.label ?? "";
    if (label === "frame the question") return "## Question\nOwn plugin API or separate executables?";
    if (label in ADVICE) return ADVICE[label]!;
    if (label === "synthesize the document") return SYNTHESIS;
    if (label === "verify the synthesis") return `\`\`\`json\n${JSON.stringify({ verdict, reason })}\n\`\`\``;
    throw new Error(`unexpected stage label: ${label}`);
  };
}

describe("consilium reference workflow", () => {
  it("runs four stages: one framer, three independent advisors in parallel, a synthesizer, a verifier", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const answer = stageAnswers("accept", "Every claim traces to an advisor.");
    const { dsl, artifactStore, getJournal, root, runId } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, answer(request));
    });

    await (
      await loadWorkflow()
    )(dsl, FIXTURE_QUESTION);

    expect(calls.map((call) => call.label)).toEqual([
      "frame the question",
      "evidence advisor",
      "risk advisor",
      "alternative advisor",
      "synthesize the document",
      "verify the synthesis",
    ]);
    expect(calls.map((call) => call.phase)).toEqual(["frame", "advise", "advise", "advise", "synthesize", "verify"]);
    // Every stage is read-only, which is also what makes `attempts` legal on each.
    expect(calls.every((call) => call.readOnly === true)).toBe(true);
    expect(calls.map((call) => call.tools?.join(","))).toEqual([
      "",
      "read,grep,find",
      "read,grep,find",
      "read,grep,find",
      "",
      "",
    ]);

    // Independent by construction: no advisor sees another advisor's text.
    const advisorCalls = calls.slice(1, 4);
    for (const [index, call] of advisorCalls.entries()) {
      for (const [otherIndex, other] of advisorCalls.entries()) {
        if (index === otherIndex) continue;
        expect(call.prompt).not.toContain(ADVICE[other.label!]!);
      }
    }
    // Three genuinely different jobs, not three copies of one prompt.
    expect(new Set(advisorCalls.map((call) => call.prompt)).size).toBe(3);
    expect(advisorCalls[0]?.prompt).toContain("EVIDENCE advisor");
    expect(advisorCalls[1]?.prompt).toContain("RISK advisor");
    expect(advisorCalls[2]?.prompt).toContain("ALTERNATIVE advisor");

    // The advisor group really is a parallel group inside a nested workflow — the
    // documented caller for `dsl.workflow()`, which nothing else in the package uses.
    const journal = getJournal();
    expect(journal.filter((line) => line.message === "[workflow:enter]")).toHaveLength(1);
    expect(journal.filter((line) => line.message === "[workflow:exit]")).toHaveLength(1);
    const group = journal.find((line) => line.kind === "group_start");
    expect(group?.groupKind).toBe("parallel");
    expect(group?.groupTotal).toBe(3);

    // The synthesizer and verifier both see all three advisor texts, verbatim.
    for (const advice of Object.values(ADVICE)) {
      expect(calls[4]?.prompt).toContain(advice);
      expect(calls[5]?.prompt).toContain(advice);
    }
    // The verifier is a fresh reader of the document, not its author.
    expect(calls[5]?.prompt).toContain(SYNTHESIS);
    expect(calls[4]?.prompt).not.toContain(SYNTHESIS);

    expect(artifactStore.list().map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "answer:brief.md",
      "answer:advisor-evidence.md",
      "answer:advisor-risk.md",
      "answer:advisor-alternative.md",
      "answer:synthesis-draft.md",
      "answer:verification.json",
      "published:consilium.md",
    ]);

    // Not just index entries: three advisor documents are really on disk under the
    // run's own artifacts directory, each holding that advisor's exact text.
    const artifactsDir = path.join(root, ".locus", "runtime", "workflows", runId, "artifacts");
    for (const advisor of ["advisor-evidence.md", "advisor-risk.md", "advisor-alternative.md"]) {
      const stored = artifactStore.list().find(({ name }) => name === advisor);
      expect(stored, advisor).toBeDefined();
      const onDisk = path.join(artifactsDir, stored!.relativePath);
      expect(existsSync(onDisk), onDisk).toBe(true);
      expect(readFileSync(onDisk, "utf8")).toBe(ADVICE[advisor.replace(/^advisor-(.+)\.md$/u, "$1 advisor")]);
    }
  });

  it("publishes a terminal consilium.md on accept, inside its declared bound", async () => {
    const answer = stageAnswers("accept", "Every claim traces to an advisor.");
    const { dsl, artifactStore } = runtimeWith(async (request) => completed(request, answer(request)));

    const result = (await (
      await loadWorkflow()
    )(dsl, FIXTURE_QUESTION)) as {
      ok: boolean;
      verdict: string;
      reason: string;
      consiliumRef: { artifactId: string; name: string };
    };

    expect(result.ok).toBe(true);
    expect(["accept", "reject"]).toContain(result.verdict);
    expect(result.verdict).toBe("accept");
    expect(result.reason).toBe("Every claim traces to an advisor.");

    const record = artifactStore.list().find(({ name }) => name === "consilium.md");
    expect(record?.kind).toBe("published");
    const text = artifactStore.read(result.consiliumRef as never).toString("utf8");
    expect(text.trim()).not.toBe("");
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toContain("## Where they disagree");
  });

  it("ends the run on reject with the verifier's named reason and no terminal artifact", async () => {
    const reason = "The document credits the risk advisor with a claim only the alternative advisor made.";
    const answer = stageAnswers("reject", reason);
    const { dsl, artifactStore } = runtimeWith(async (request) => completed(request, answer(request)));

    const result = (await (
      await loadWorkflow()
    )(dsl, FIXTURE_QUESTION)) as {
      ok: boolean;
      verdict: string;
      reason: string;
      summary: string;
    };

    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("reject");
    // The verifier's own words reach the operator; the script never rewrites them.
    expect(result.reason).toBe(reason);
    expect(result.summary).toContain(reason);
    // Fail closed means nothing terminal was published.
    expect(artifactStore.list().some(({ name }) => name === "consilium.md")).toBe(false);
  });

  it("refuses a run with no question before any child starts", async () => {
    let calls = 0;
    const { dsl } = runtimeWith(async () => {
      calls += 1;
      throw new Error("must not run");
    });
    const workflow = await loadWorkflow();

    await expect(workflow(dsl, "   ")).rejects.toThrow("consilium requires a non-empty question");
    await expect(workflow(dsl, undefined)).rejects.toThrow("consilium requires a non-empty question");
    expect(calls).toBe(0);
  });

  it("keeps the verifier's verdict a declared value the script never has to read prose for", () => {
    const source = readFileSync(workflowPath, "utf8");

    // The single branch is on one runtime-validated enum member. A regex over the
    // verifier's prose would be the exact failure this reference exists to avoid.
    expect(source).toContain('enum: ["accept", "reject"]');
    expect(source).toContain('verification.verdict === "reject"');
    expect(source).not.toMatch(/verification\.reason\s*\.\s*(includes|match|test)/u);
    expect(source).not.toContain("JSON.parse");
    // No tier pins until the resolver is fail-loud and the journal records the
    // executed model; a showcase whose journal lies is worse than no showcase.
    expect(source).not.toMatch(/^\s*model:/mu);
  });

  it("stays out of the Package registry by placement, and still loads by path", async () => {
    const { packagedWorkflowNames, resolveWorkflowTarget } =
      await import("../../../extensions/_shared/workflow-runner.js");

    // `references/` is a sibling of the scanned `examples/` directory and is never
    // visited, so this file is unreachable by name.
    expect([...packagedWorkflowNames()].sort()).toEqual([
      "live-smoke",
      "plan",
      "plan-implement",
      "requirements-grill",
      "review",
      "review-fix",
    ]);
    expect(packagedWorkflowNames()).not.toContain("consilium");

    // The name form does not resolve …
    expect(() => resolveWorkflowTarget({ name: "consilium" }, process.cwd())).toThrow(/consilium/u);

    // … and the path form does, at the file this reference actually is.
    const byPath = resolveWorkflowTarget(
      { scriptPath: "extensions/workflows/references/consilium/consilium.workflow.mjs" },
      process.cwd(),
    );
    expect(byPath.kind).toBe("scriptPath");
    expect(byPath.path).toBe(workflowPath);
  });
});
