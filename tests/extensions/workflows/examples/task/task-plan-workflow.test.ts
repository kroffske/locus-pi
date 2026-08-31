import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { buildWorkflowCatalogModel } from "../../../../../extensions/workflows/catalog/workflow-catalog.js";
import {
  resolveWorkflowTarget,
  runWorkflowScript,
} from "../../../../../extensions/workflows/runtime/workflow-runner.js";
import { standardWorkflowSourceShapeErrors } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";
import { createHarness } from "../../../../test-harness.js";

const workflowDirectory = path.join(process.cwd(), "extensions/workflows/examples/task");
const workflowPath = path.join(workflowDirectory, "plan.workflow.mjs");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-plan-minimal-"));
  temporaryRoots.push(root);
  const agentDir = path.join(root, ".agents", "agents");
  const workflowDir = path.join(root, ".pi", "workflows", "task");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "default.md"),
    "---\nname: default\ndescription: Test default agent\nevidence:\n  mode: none\n---\nFollow the task.\n",
    "utf8",
  );
  writeFileSync(path.join(workflowDir, "plan.workflow.mjs"), readFileSync(workflowPath, "utf8"), "utf8");
  return root;
}

function completed(request: AgentRunRequest, text: string) {
  return {
    status: "completed" as const,
    agentName: request.agent?.name ?? "sub-agent",
    reason: text,
    text,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

function failed(request: AgentRunRequest, reason: string) {
  return {
    status: "failed" as const,
    agentName: request.agent?.name ?? "sub-agent",
    reason,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

interface FakeCall {
  prompt: string;
  label: string;
  choice?: string[];
  choiceFallback?: string;
}

function fakeDsl(record: { calls: FakeCall[]; phases: string[]; published: string[]; routeAnswer: string }) {
  return {
    phase: (name: string) => record.phases.push(name),
    log: () => undefined,
    projectRoot: () => "/tmp/locus-plan-fake-project",
    outputDir: () => "tmp/cron-to-dag",
    parallel: (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((thunk) => thunk())),
    agent: async (prompt: string, options: FakeCall) => {
      record.calls.push({ ...options, prompt });
      if (options.choice !== undefined) return record.routeAnswer;
      return `ANSWER:${options.label}`;
    },
    publishPrimaryFile: (relativePath: string) => {
      record.published.push(relativePath);
      return { relativePath };
    },
  };
}

describe("Package workflow: task/plan", () => {
  it("shares a group-only Package namespace with rendering and substep entries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-task-family-"));
    temporaryRoots.push(root);
    expect(buildWorkflowCatalogModel(root, root).groups).toContainEqual(
      expect.objectContaining({
        name: "task",
        source: "package",
        children: [
          "task/draft",
          "task/implement-plan-template",
          "task/implement-plan-v2-template",
          "task/plan",
          "task/substep",
        ],
      }),
    );
    expect(() => resolveWorkflowTarget({ name: "task" }, root, root)).toThrow(
      /group-only and has no runnable root: task/u,
    );
  });

  it("is a standard decomposed no-ask graph with no operator gate or model pin", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    // scope, context, compose, correct, verify, route, blocker.
    expect(source.match(/await agent\(/gu)).toHaveLength(7);
    // Two parallel barriers: three analyses, three reviews.
    expect(source.match(/await parallel\(\[/gu)).toHaveLength(2);
    expect(source.match(/\(\) =>\s+agent\(/gu)).toHaveLength(6);
    expect(source).toContain('choice: ["ready", "blocked"]');
    expect(source).toContain('choiceFallback: "blocked"');
    // Never waits for an operator and never resumes an operator handoff.
    expect(source).not.toContain("awaitOperator");
    expect(source).not.toContain("continuationArtifacts");
    expect(source).not.toContain("operatorHandoff");
    expect(source).not.toContain("promptFile");
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\bcritic\b/u);
    expect(source).not.toMatch(/\b(?:schema|validate|items)\s*:/u);
    expect(source).not.toMatch(/\b(?:pipeline|invokeWorkflow)\s*\(/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
    // The retired single-run renderer name must not resurface here.
    expect(source).not.toContain("task/script");
  });

  it("runs scope, context, three analyses, compose, three reviews, correction, and verification in order", async () => {
    const runWorkflow = await loadWorkflow();
    const record = { calls: [] as FakeCall[], phases: [] as string[], published: [] as string[], routeAnswer: "ready" };
    const result = await runWorkflow(fakeDsl(record), "Move the cron job into a DAG");

    expect(record.phases).toEqual([
      "scope",
      "context",
      "analyze",
      "compose",
      "review",
      "correct",
      "verify",
      "route",
      "publish",
    ]);
    expect(record.calls.map((call) => call.label)).toEqual([
      "scope",
      "context",
      "task-semantics",
      "repository-integration",
      "verification-strategy",
      "compose",
      "plan-correctness",
      "integration-review",
      "step-usability",
      "correct",
      "verify",
      "route",
    ]);

    const prompts = Object.fromEntries(record.calls.map((call) => [call.label, call.prompt]));
    // Every model-facing stage carries the no-ask rule; the route choice is runtime-owned.
    for (const call of record.calls) {
      if (call.choice !== undefined) continue;
      expect(call.prompt, call.label).toContain("This workflow never pauses for an operator answer");
      expect(call.prompt, call.label).toContain("Never invent a concrete project value");
    }

    expect(prompts.scope).toContain("Move the cron job into a DAG");
    expect(prompts.scope).toContain("saved draft is the primary accepted task direction");
    expect(prompts.scope).toContain("When no saved draft exists, use the semantic task directly");
    expect(prompts.scope).toContain("Fully replace `request.md`");
    expect(prompts.scope).toContain("Fully replace `scope.md`");
    expect(prompts.context).toContain("ANSWER:scope");
    expect(prompts.context).toContain("Fully replace `context.md`");
    expect(prompts["task-semantics"]).toContain("analysis/task-semantics.md");
    expect(prompts["repository-integration"]).toContain("analysis/repository-integration.md");
    expect(prompts["verification-strategy"]).toContain("analysis/verification-strategy.md");

    expect(prompts.compose).toContain("ANSWER:task-semantics");
    expect(prompts.compose).toContain("ANSWER:repository-integration");
    expect(prompts.compose).toContain("ANSWER:verification-strategy");
    expect(prompts.compose).toContain("ANSWER:scope");
    expect(prompts.compose).toContain("fully replace the planning files");
    expect(prompts.compose).toContain("`plan.md`");
    expect(prompts.compose).toContain("`step-1.md`, `step-2.md`");
    expect(prompts.compose).toContain("first define coherent top-level work units");
    expect(prompts.compose).toContain("the only executable task catalog");
    expect(prompts.compose).toContain("'Assumptions and prerequisites'");
    expect(prompts.compose).toMatch(/Do not create\s+`steps\.md`, `tasks\.md`/u);
    expect(prompts.compose).toContain("one complete flat block");
    expect(prompts.compose).toContain("use no nested structural headings");
    expect(prompts.compose).toMatch(/whose `S<n>`\s+matches the `<n>` in its file name/u);
    expect(prompts.compose).toMatch(/Delete any leftover `step-<n>\.md`/u);
    for (const field of [
      "Work unit:",
      "Boundary:",
      "Goal:",
      "Paths and evidence:",
      "Dependencies:",
      "Allowed ownership:",
      "Verification:",
      "Done when:",
    ]) {
      expect(prompts.compose, field).toContain(field);
    }
    for (const boundary of [
      /file boundary for isolated file ownership/u,
      /function boundary for one\s+behavior with local callers/u,
      /behavior boundary when one observable contract\s+crosses files/u,
      /side-effect boundary for database, API, email, file, or\s+subprocess operations/u,
      /ownership boundary for configuration, common, or\s+platform modules/u,
    ]) {
      expect(prompts.compose, boundary.source).toMatch(boundary);
    }
    expect(prompts.compose).toContain("`implement-plan.workflow.mjs`");
    expect(prompts.compose).toContain("`task/implement-plan-template`");
    expect(prompts.compose).toContain("`task/substep`");
    expect(prompts.compose).toMatch(/`locus-pi-workflow-create` skill as a normal authoring request/u);
    expect(prompts.compose).toMatch(/nothing is\s+executed until the owner reviews/u);
    expect(prompts.compose).toMatch(/the owner may edit those files first/u);
    expect(prompts.compose).toMatch(/files on disk stay the contract every later run reads/u);
    expect(prompts.compose).toMatch(/plan approval starts neither\s+implementation nor workflow authoring/u);
    expect(prompts.compose).toMatch(/renders no script/u);
    expect(prompts.compose).toContain("Every mandatory success marker must have one reachable producer");
    expect(prompts.compose).toContain("`Done when:` contains success conditions");
    expect(prompts["step-usability"]).toContain("Trace every mandatory success marker");
    expect(prompts["step-usability"]).toContain("plan-controlled `*_BLOCKED`");

    expect(prompts.correct).toContain("ANSWER:plan-correctness");
    expect(prompts.correct).toContain("ANSWER:integration-review");
    expect(prompts.correct).toContain("ANSWER:step-usability");
    expect(prompts.correct).toContain("single bounded correction");
    expect(prompts.correct).toContain("success path no step is allowed to produce");
    expect(prompts.verify).toContain("ANSWER:correct");
    expect(prompts.verify).toContain("'Conclusion: ready' or 'Conclusion: blocked'");
    expect(prompts.verify).toContain("mandatory success marker has no");
    expect(prompts.verify).toContain("failed or blocked alternative inside `Done when:`");
    expect(prompts.route).toContain("ANSWER:verify");
    expect(prompts.route).toContain("mandatory success path reported unreachable");

    expect(record.published).toEqual(["plan.md"]);
    expect(result).toContain("Planning is complete and nothing has been implemented");
    expect(result).toContain("This run stops here");
    expect(result).toContain("Reading this result is not approval");
    expect(result).toMatch(/Do not start implementation, do not\s+create implementation todos/u);
    expect(result).toContain("step-<n>.md — the frozen executable catalog");
    expect(result).toContain("You may edit plan.md and the step-<n>.md files before execution");
    expect(result).toContain("task/implement-plan-template on this same workspace");
    expect(result).toContain("implement-plan.workflow.mjs");
    expect(result).toContain("task/substep");
    expect(result).not.toContain("task-via-script");
    expect(result).not.toContain("task/script");
    expect(result).toContain("locus-pi-workflow-create skill");
    expect(result).toContain("Author a sequential project-local workflow");
  });

  it("fails closed publishing planning-blocker.md when the final route says blocked", async () => {
    const runWorkflow = await loadWorkflow();
    const record = {
      calls: [] as FakeCall[],
      phases: [] as string[],
      published: [] as string[],
      routeAnswer: "blocked",
    };
    const result = await runWorkflow(fakeDsl(record), "Move the cron job into a DAG");

    expect(record.calls.map((call) => call.label)).toEqual([
      "scope",
      "context",
      "task-semantics",
      "repository-integration",
      "verification-strategy",
      "compose",
      "plan-correctness",
      "integration-review",
      "step-usability",
      "correct",
      "verify",
      "route",
      "blocker",
    ]);
    const blocker = record.calls.at(-1)!;
    expect(blocker.prompt).toContain("ANSWER:verify");
    expect(blocker.prompt).toContain("'# Planning Blocker'");
    expect(blocker.prompt).toContain("do not ask\na question");
    expect(record.published).toEqual(["planning-blocker.md"]);
    expect(result).toContain("Planning finished BLOCKED");
    expect(result).toContain("This run stops here");
    expect(result).toContain("never waits for an operator answer");
  });

  it("resumes after a compose failure without repeating scope, context, or the analyses", async () => {
    const root = temporaryProject();
    const workspace = path.join(root, "tmp", "cron-to-dag");
    const task = "Move the cron job into a DAG";
    const roleOf = (request: AgentRunRequest): string => {
      const text = request.task;
      if (text.includes("You own only request capture and scope")) return "scope";
      if (text.includes("You are the only live evidence collector")) return "context";
      if (text.includes("task-semantics analysis")) return "task-semantics";
      if (text.includes("repository-integration analysis")) return "repository-integration";
      if (text.includes("verification-strategy analysis")) return "verification-strategy";
      if (text.includes("You are the only plan writer")) return "compose";
      if (text.includes("plan-correctness reviewer")) return "plan-correctness";
      if (text.includes("repository-integration reviewer")) return "integration-review";
      if (text.includes("step-usability reviewer")) return "step-usability";
      if (text.includes("single bounded correction")) return "correct";
      if (text.includes("final independent verifier")) return "verify";
      if (text.includes("Route the final task/plan verification")) return "route";
      return "unexpected";
    };

    const firstHarness = createHarness(root, { sessionId: "plan-first" });
    const firstCalls: string[] = [];
    const firstExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        const role = roleOf(request);
        firstCalls.push(role);
        mkdirSync(workspace, { recursive: true });
        if (role === "scope") {
          writeFileSync(path.join(workspace, "scope.md"), "# Scope\nverbatim request\n", "utf8");
          return completed(request, "# Scope\nverbatim request");
        }
        if (role === "context") {
          writeFileSync(path.join(workspace, "context.md"), "# Context\nrepository map\n", "utf8");
          return completed(request, "# Context\nrepository map");
        }
        if (role.endsWith("-semantics") || role === "repository-integration" || role === "verification-strategy") {
          return completed(request, `# Analysis\n${role}`);
        }
        return failed(request, "compose interrupted");
      },
    });
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "task/plan",
      input: task,
      outputDir: "tmp/cron-to-dag",
      createExecutor: firstExecutor,
    });

    expect(first.ok).toBe(false);
    expect(firstCalls.slice(0, 2)).toEqual(["scope", "context"]);
    expect([...firstCalls.slice(2, 5)].sort()).toEqual([
      "repository-integration",
      "task-semantics",
      "verification-strategy",
    ]);
    expect(firstCalls.at(5)).toBe("compose");
    expect(existsSync(path.join(workspace, "context.md"))).toBe(true);

    const resumedHarness = createHarness(root, { sessionId: "plan-resumed" });
    const resumedCalls: string[] = [];
    const resumedExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        const role = roleOf(request);
        resumedCalls.push(role);
        if (role === "compose") {
          writeFileSync(path.join(workspace, "plan.md"), "# Plan\nMove the cron job.\n", "utf8");
          writeFileSync(path.join(workspace, "step-1.md"), "## S1 — Add the DAG\n", "utf8");
          return completed(request, "# Plan\nMove the cron job.");
        }
        if (role === "verify") {
          writeFileSync(path.join(workspace, "verification.md"), "# Verification\nConclusion: ready\n", "utf8");
          return completed(request, "# Verification\nConclusion: ready");
        }
        // A choice desugars to the string-enum schema path, so the child answers JSON.
        if (role === "route") return completed(request, JSON.stringify("ready"));
        if (role === "unexpected") return failed(request, "unexpected call");
        return completed(request, `# Review\n${role}: None.`);
      },
    });
    const resumed = await runWorkflowScript({
      pi: resumedHarness.pi,
      ctx: resumedHarness.ctx,
      signal: new AbortController().signal,
      name: "task/plan",
      input: task,
      outputDir: "tmp/cron-to-dag",
      resumeFromRunId: first.runId,
      createExecutor: resumedExecutor,
    });

    expect(resumed.ok).toBe(true);
    // The completed scope and context prefix replays instead of re-running. The
    // three parallel analyses may replay or re-run depending on the recorded
    // completion order; positional replay only guarantees the sequential prefix.
    expect(resumedCalls).not.toContain("scope");
    expect(resumedCalls).not.toContain("context");
    expect(resumedCalls).toContain("compose");
    expect(resumedCalls.at(-1)).toBe("route");
    expect(resumed.replay).toMatchObject({
      replayed: true,
      sourceRunId: first.runId,
    });
    expect(resumed.primaryFile?.relativePath).toBe("plan.md");
    expect(readFileSync(path.join(workspace, "step-1.md"), "utf8")).toContain("## S1");
    expect(existsSync(path.join(workspace, "implement-plan.workflow.mjs"))).toBe(false);
    expect(String(resumed.result)).toContain("This run stops here");
  });
});
