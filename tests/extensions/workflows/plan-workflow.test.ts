import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowArtifactPorts, WorkflowArtifactRef } from "../../../extensions/_shared/workflow-artifacts.js";
import { createWorkflowResourceLoader } from "../../../extensions/_shared/workflow-resources.js";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

/**
 * The tracked `plan` example. One loop carries its "iteratively" claim, and it can
 * end in two ways, so both are pinned here: the drafting loop must stop on the
 * critic's verdict, and the round cap is the safety net that fails the run.
 */
const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/plan/plan.workflow.mjs");

interface PublishedArtifact {
  ref: WorkflowArtifactRef;
  text: string;
  stage?: string;
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
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

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function priorRef(runId: string, artifactId: string, name: string, text: string): WorkflowArtifactRef {
  return { runId, artifactId, name, sha256: digest(text) };
}

function runtimeWith(runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>) {
  const runId = "plan-test";
  const runDir = mkdtempSync(path.join(tmpdir(), "locus-plan-workflow-"));
  const published: PublishedArtifact[] = [];
  const answers: PublishedArtifact[] = [];
  const artifactPorts: WorkflowArtifactPorts = {
    recordAgentEvidence(input) {
      if (input.text === undefined) return {};
      const ref = priorRef(runId, `answer-${answers.length + 1}`, input.name, input.text);
      answers.push({ ref, text: input.text, ...(input.stage === undefined ? {} : { stage: input.stage }) });
      return { answer: ref };
    },
    publishText(name, text, stage) {
      const ref = priorRef(runId, `published-${published.length + 1}`, name, text);
      published.push({ ref, text, ...(stage === undefined ? {} : { stage }) });
      return ref;
    },
    consumeText(ref) {
      throw new Error(`unexpected workflow-local artifact consume: ${ref.name}`);
    },
  };
  return {
    ...createWorkflowRuntime({
      runId,
      agentRunner: runner,
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      artifactPorts,
      projectRoot: process.cwd(),
    }),
    published,
    answers,
  };
}

const PLAN_DRAFT = [
  "# Implementation Plan",
  "## Goal",
  "The offset advances.",
  "",
  "## Assumptions",
  "- Assumed the caller owns the offset, because `loadPage` reads it; wrong if the store owns it.",
  "",
  "## Steps",
  "### S1 — Advance the offset",
  "Files: `src/page.ts`",
  "Change: Advance the offset.",
  "Verify: `npm test -- page`",
  "Depends on: none",
  "",
  "## Out of scope",
  "- Renaming the module.",
  "",
  "## Open questions",
  "- none",
].join("\n");

/** Everything before the drafting loop, so a loop test only writes the loop. */
const SCOUT_CONTEXT = "# Task Context\n## Existing behavior\n- `src/page.ts` — paginates.";

describe("workflow example: plan.workflow.mjs", () => {
  it("keeps every planning stage read-only and lets the runtime own every artifact", () => {
    const source = readFileSync(workflowPath, "utf8");

    // Planning reads; it never writes. If this ever fails, a "plan" run can
    // change the operator's working tree without the operator asking for it.
    expect(source.match(/readOnly: true/gu)).toHaveLength(1);
    expect(source).not.toContain('"write"');
    expect(source).not.toContain('"edit"');
    expect(source).not.toContain('"bash"');
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);

    expect(source).toContain("const COMMON = ");
    // Three named prompt builders: no prompt here is long enough to earn a file.
    expect(source).not.toContain("promptFile");
    expect(source.match(/^\s*return `\$\{COMMON\}$/gmu)).toHaveLength(3);

    // The loop branches on a declared shape plus a cross-field callback, never on
    // a regex over the model's Markdown.
    expect(source).toContain("PLAN_VERDICT_SCHEMA");
    expect(source).toContain("validate: planVerdictErrors");
    expect(source).toContain("const MAX_PLAN_ROUNDS = 4");
    expect(source).not.toContain("JSON.parse");

    for (const name of ["context.md", "plan.md", "plan-critique.json"]) {
      expect(source, name).toContain(`artifact: "${name}"`);
    }
    for (const bound of ["maxAnswerChars: MAX_CONTEXT_CHARS", "maxAnswerChars: MAX_PLAN_CHARS"]) {
      expect(source, bound).toContain(bound);
    }
  });

  it("takes every agent's capabilities and every label from the one roster", async () => {
    // The roster is the cast list, and a capability lives in exactly one place: a
    // tools array copied per call site is how one planning stage quietly becomes
    // write-capable while the other two stay read-only.
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("const PLAN_AGENTS = Object.freeze({");
    expect(source.match(/tools: \[/gu)).toHaveLength(1);
    expect(source.match(/\.\.\.PLAN_AGENTS\.\w+\.options,/gu)).toHaveLength(3);
    // Each call site adds the label and nothing else, and the label is built from
    // the roster id, so a stage name cannot drift away from the cast list.
    expect(source.match(/^\s*label: /gmu)).toHaveLength(3);
    expect(source).toContain("label: PLAN_AGENTS.scout.id");
    expect(source).toContain("label: `${PLAN_AGENTS.planner.id} round ${round}`");
    expect(source).toContain("label: `${PLAN_AGENTS.critic.id} round ${round}`");

    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": '{"verdict":"accept","defects":[]}',
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await runWorkflow(dsl, "advance pagination");

    expect(calls.map((call) => call.label)).toEqual(["scout", "planner round 1", "critic round 1"]);
    expect(calls[0]?.tools).toEqual(["read", "git_read", "ast_index", "grep", "find"]);
    // One shared roster option object means one capability set for all three.
    const capabilities = calls.map((call) =>
      JSON.stringify({
        tools: call.tools,
        readOnly: call.readOnly,
        maxToolCalls: call.maxToolCalls,
        workspaceMode: call.workspaceMode,
        permissionMode: call.permissionMode,
      }),
    );
    expect(new Set(capabilities).size).toBe(1);
  });

  it("makes the planner record what it assumed and the critic treat a hidden decision as a defect", () => {
    // Nothing pauses this run for an answer, so an open decision has to land in
    // writing instead. The critic is what makes that binding: a plan cannot buy an
    // accept by staying vague about a choice it silently depends on.
    const source = readFileSync(workflowPath, "utf8");
    const prose = source.replace(/\s+/gu, " ");

    expect(source).toContain("\n## Assumptions\n- Assumed X, because Y; wrong if Z.");
    expect(prose).toContain('in the exact form "assumed X, because Y; wrong if Z"');

    expect(prose).toContain("a decision the plan depends on but never states — an unstated assumption is a defect");
    expect(prose).toContain("while a choice recorded under \\`## Assumptions\\` with its reason is not");
  });

  it("tells both roles that a step is one changed thing, verified by a command", () => {
    // Three failures from one live run on 2026-07-28, each addressed on both
    // sides so the critic can refuse what the planner is told not to write: a
    // plan whose first "step" only read nine files, a second step that wrote
    // three independent document sections at once, and verifications no later
    // agent could rerun, which forced the implementation report to grade every
    // step partial.
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain("Every step changes the repository.");
    expect(prose).toContain("a step that changes nothing");
    expect(prose).toContain("give each one its own step");
    expect(prose).toContain("one step covering more than one of them is exactly that");
    expect(prose).toContain("one command a later agent can rerun without a human");
    expect(prose).toContain("a step block missing any of the mandatory");
  });

  it("tells both roles that a shared destination file does not justify one step", () => {
    // The 2026-07-28 rerun on the same local model closed the previous gap and
    // opened this one: the plan collapsed to a single step for all three
    // sections, and the critic's own reasoning excused it because the task said
    // "in one new file". The exemption for work that cannot be done apart is
    // real, but a shared destination is not an instance of it, so both sides are
    // told what does not count.
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain("One destination is not such a reason.");
    expect(prose).toContain("the shared file says where the work goes, not that it is one job");
    expect(prose).toContain("That they share one destination file is not such a reason");
    expect(prose).toContain("a shared file states where the work goes, not that it is one job");
  });

  it("tells both roles that a closing verification step is a step that changes nothing", () => {
    // The same rerun accepted a final "integrity pass" step whose whole content
    // was re-checking what the earlier steps' own verifications already prove.
    // The ban on steps that change nothing was already there; it did not read as
    // covering a step called a verification, so both roles now say it does.
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain(
      "A closing step that checks the finished result is the same mistake wearing a different name.",
    );
    expect(prose).toContain("The plan ends with the last step that changes something.");
    expect(prose).toContain(
      "A closing step that verifies the finished result is this defect and not an exception to it",
    );
  });

  it("accepts the first draft when the critic accepts it, and returns that exact text", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, published, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });
    const task = "  make pagination advance past the first page  \n";

    const result = await runWorkflow(dsl, task);

    expect(result).toBe(PLAN_DRAFT);
    expect(calls.map((call) => call.label)).toEqual(["scout", "planner round 1", "critic round 1"]);
    expect(calls.every((call) => call.readOnly === true)).toBe(true);
    // The operator's exact words reach every stage; no stage sees a paraphrase.
    expect(calls.every((call) => call.prompt.includes(task))).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual(["scout-repository", "draft-plan", "critique-plan"]);
    expect(calls[1]?.prompt).toContain(SCOUT_CONTEXT);
    expect(calls[2]?.prompt).toContain(PLAN_DRAFT);
    expect(published.map((item) => item.ref.name)).toEqual(["task.md"]);
    expect(published[0]?.text).toBe(task);
    expect(answers.map((item) => item.ref.name)).toEqual(["context.md", "plan.md", "plan-critique.json"]);
  });

  it("redrafts with the critic's exact defects and retains every round separately", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const secondDraft = PLAN_DRAFT.replace("Advance the offset.", "Advance the offset in `loadPage`.");
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": JSON.stringify({
        verdict: "revise",
        defects: ["S1: `src/page.ts` has no offset variable; name the symbol the step changes"],
      }),
      "planner round 2": secondDraft,
      "critic round 2": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    expect(await runWorkflow(dsl, "advance pagination")).toBe(secondDraft);
    expect(calls.map((call) => call.label)).toEqual([
      "scout",
      "planner round 1",
      "critic round 1",
      "planner round 2",
      "critic round 2",
    ]);
    // The second draft receives the first draft and the defect sentence verbatim,
    // numbered — not a summary the script invented.
    expect(calls[3]?.prompt).toContain(PLAN_DRAFT);
    expect(calls[3]?.prompt).toContain("1. S1: `src/page.ts` has no offset variable; name the symbol the step changes");
    // Both rounds are retained under the same reader-facing name: the artifact id
    // is the identity, so nothing is overwritten.
    expect(answers.map((item) => item.ref.name)).toEqual([
      "context.md",
      "plan.md",
      "plan-critique.json",
      "plan.md",
      "plan-critique.json",
    ]);
    expect(answers[1]?.text).toBe(PLAN_DRAFT);
    expect(answers[3]?.text).toBe(secondDraft);
  });

  it("fails the run when the round cap is reached without an accepted plan", async () => {
    // A draft nobody accepted is not a plan, and failing here is also what keeps
    // it out of `plan-implement`: continuation consumes only a successful run's
    // projected artifacts.
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "scout") return completed(request, SCOUT_CONTEXT);
      if (request.label!.startsWith("critic")) {
        return completed(request, JSON.stringify({ verdict: "revise", defects: ["S1: still unverifiable"] }));
      }
      return completed(request, PLAN_DRAFT);
    });

    expect(await runWorkflow(dsl, "advance pagination")).toEqual({
      ok: false,
      stoppedBy: "round-cap",
      rounds: 4,
      summary: "plan was not accepted within 4 drafting round(s)",
      unresolvedRows: ["S1: still unverifiable"],
    });
    expect(calls.filter((call) => call.label!.startsWith("planner"))).toHaveLength(4);
    expect(calls.at(-1)?.label).toBe("critic round 4");
  });

  it.each([
    [
      { verdict: "accept", defects: ["a defect nobody will read"] },
      "verdict accept must carry no defects: withdraw them or return verdict revise",
    ],
    [{ verdict: "revise", defects: [] }, "verdict revise must name at least one defect the next draft can close"],
  ])("re-asks the critic for a verdict that disagrees with its own defects", async (verdict, message) => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "scout") return completed(request, SCOUT_CONTEXT);
      if (request.label!.startsWith("critic")) return completed(request, JSON.stringify(verdict));
      return completed(request, PLAN_DRAFT);
    });

    const rejection = runWorkflow(dsl, "advance pagination");
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow(message);
    // Three attempts: a call that declares `validate` gets one dedicated extra one.
    expect(calls.filter((call) => call.label === "critic round 1")).toHaveLength(3);
    // The re-ask reaches only the call that failed: a stage that answered fine
    // never sees the validator's rejection banner.
    expect(calls[1]?.prompt).not.toContain("REJECTED by the workflow script");
    expect(calls.some((call) => call.label === "planner round 2")).toBe(false);
  });

  it("refuses an empty task, and bounds nothing the host already bounds", async () => {
    const runWorkflow = await loadWorkflow();
    const { dsl } = runtimeWith(async (request) => completed(request, "unused"));

    await expect(runWorkflow(dsl, "   ")).rejects.toThrow("plan requires a non-empty task");
    await expect(runWorkflow(dsl, { task: "object" })).rejects.toThrow("plan requires a non-empty task");

    // The host caps workflow input on both entry surfaces. A second copy of that
    // number here can only agree with it or wrongly disagree, and the copy that
    // used to live here was never reachable.
    const source = readFileSync(workflowPath, "utf8");
    expect(source).not.toMatch(/MAX_TASK_CHARS|input\.length|taskText\.length/u);
  });
});
