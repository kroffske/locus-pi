import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import * as runner from "../../../extensions/_shared/workflow-runner.js";
import { runWorkflowScript } from "../../../extensions/_shared/workflow-runner.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness } from "../../test-harness.js";

/** T-120 — workflow semantic input is one optional bounded string. */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-input-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Input test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

function writeWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

/** Reports back exactly what the second parameter of runWorkflow() was. */
const ECHO_INPUT_WORKFLOW = `export const meta = { name: "echo-input", description: "Report the received input shape." };
export default async function runWorkflow(dsl, input) {
  await dsl.agent("inspect");
  return {
    ok: true,
    receivedType: Array.isArray(input) ? "array" : typeof input,
    received: input,
  };
}
`;

interface RunOutcome {
  ok: boolean;
  result: unknown;
  /** Per-child request metadata, where the runner surfaces the run's `args`. */
  metadata: Array<Record<string, unknown> | undefined>;
}

async function runEcho(root: string, input?: string): Promise<RunOutcome> {
  const harness = createHarness(root, { sessionId: "workflow-input" });
  const metadata: Array<Record<string, unknown> | undefined> = [];
  const createExecutor = (): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      metadata.push(request.metadata as Record<string, unknown> | undefined);
      return {
        status: "completed" as const,
        agentName: request.agent.name,
        reason: "answered",
        text: "ok",
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
  const res = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name: "echo-input",
    createExecutor,
    ...(input !== undefined ? { input } : {}),
  });
  return { ok: res.ok, result: res.result, metadata };
}

function registerTool() {
  const harness = createHarness();
  workflows(harness.pi);
  return { harness, tool: harness.tools.get("workflow")! };
}

describe("string-only workflow input", () => {
  it("persists awaiting_operator beside the workflow's unchanged prepared result", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "await-operator",
      `export default async function runWorkflow(dsl) {
  dsl.awaitOperator({ reason: "review clarification required" });
  return { mode: "prepared", token: "unchanged" };
}
`,
    );
    const harness = createHarness(root, { sessionId: "workflow-await-operator" });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "await-operator",
    });

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ mode: "prepared", token: "unchanged" });
    expect(result.disposition).toEqual({
      status: "awaiting_operator",
      detail: "review clarification required",
    });
    expect(JSON.parse(readFileSync(result.resultPersistence.path, "utf8"))).toMatchObject({
      ok: true,
      result: { mode: "prepared", token: "unchanged" },
      disposition: { status: "awaiting_operator", detail: "review clarification required" },
    });
  });

  it("rejects an object at the runner boundary before any child runs", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const harness = createHarness(root, { sessionId: "workflow-input-object" });
    let childCalls = 0;
    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "echo-input",
      createExecutor: () => ({
        async run() {
          childCalls += 1;
          throw new Error("must not run");
        },
      }),
      // Runtime guard for untyped JavaScript/direct callers.
      input: { target: "src/auth" },
    } as unknown as runner.RunWorkflowScriptOptions);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("workflow input must be a string");
    expect(childCalls).toBe(0);
  });

  it("leaves the free-text path byte-for-byte as it was", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);

    const outcome = await runEcho(root, "review the auth module");

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      receivedType: "string",
      received: "review the auth module",
    });
    expect(outcome.metadata[0]).toMatchObject({ workflowArgs: "review the auth module" });
  });

  it("accepts only absent or bounded string input in the tool schema", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;

    expect(Value.Check(schema, { name: "demo", input: "free text" })).toBe(true);
    expect(Value.Check(schema, { name: "demo" })).toBe(true);
    expect(Value.Check(schema, { name: "demo", input: { target: "src", depth: 2 } })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: ["a", "b"] })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: 7 })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: null })).toBe(false);
  });

  it("refuses an over-budget string before any run is created", async () => {
    const { harness, tool } = registerTool();
    const spy = vi.spyOn(runner, "runWorkflowScript");
    try {
      const oversized = "x".repeat(20_000);
      const result = await tool.execute(
        "tool-1",
        { name: "live-smoke", input: oversized },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

      const firstContent = result.content?.[0];
      expect(result.isError).toBe(true);
      expect(firstContent?.type === "text" ? firstContent.text : "").toContain("input");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the exact supplied text instead of trimming or parsing it", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);
    const exact = "  review auth\nwith rollback focus  ";

    const outcome = await runEcho(root, exact);

    expect(outcome.result).toMatchObject({ received: exact });
    expect(outcome.metadata[0]).toMatchObject({ workflowArgs: exact });
  });
});
