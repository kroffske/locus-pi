import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import * as runner from "../../../extensions/_shared/workflow-runner.js";
import { runWorkflowScript } from "../../../extensions/_shared/workflow-runner.js";
import workflows, { checkWorkflowInputBudget } from "../../../extensions/workflows/index.js";
import { createHarness } from "../../test-harness.js";

/**
 * T-114 — a workflow's task may arrive as named parameters, not only as prose.
 *
 * Every case answers one question: can a script read a field it did not parse
 * out of a sentence, without the string path changing and without an unbounded
 * payload reaching the run directory?
 */

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

async function runEcho(root: string, input?: unknown): Promise<RunOutcome> {
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

describe("structured workflow input", () => {
  it("hands a JSON object to the script unchanged and journals it under args", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "echo-input", ECHO_INPUT_WORKFLOW);

    const args = { target: "src/auth", mode: "strict", files: ["a.ts", "b.ts"] };
    const outcome = await runEcho(root, args);

    expect(outcome.ok).toBe(true);
    // The script reads fields directly; nothing parsed the task out of prose.
    expect(outcome.result).toMatchObject({ receivedType: "object", received: args });
    // The key that existing run artifacts and replay records already use.
    expect(outcome.metadata[0]).toMatchObject({ workflowArgs: args });
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

  it("accepts both shapes in the tool schema and rejects everything else", () => {
    const { tool } = registerTool();
    const schema = tool.parameters;

    expect(Value.Check(schema, { name: "demo", input: "free text" })).toBe(true);
    expect(Value.Check(schema, { name: "demo", input: { target: "src", depth: 2 } })).toBe(true);
    expect(Value.Check(schema, { name: "demo" })).toBe(true);
    // An array or a scalar is not a named-parameter object; refuse rather than guess.
    expect(Value.Check(schema, { name: "demo", input: ["a", "b"] })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: 7 })).toBe(false);
    expect(Value.Check(schema, { name: "demo", input: null })).toBe(false);
  });

  it("refuses an over-budget object before any run is created", async () => {
    const { harness, tool } = registerTool();
    const spy = vi.spyOn(runner, "runWorkflowScript");
    try {
      const oversized = { blob: "x".repeat(20_000) };
      const result = await tool.execute(
        "tool-1",
        { name: "live-smoke", input: oversized },
        new AbortController().signal,
        () => void 0,
        harness.ctx,
      );

      const firstContent = result.content?.[0];
      expect(result.isError).toBe(true);
      expect(firstContent?.type === "text" ? firstContent.text : "").toContain("the limit is 16000");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("names a non-serializable object instead of failing inside a run", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const checked = checkWorkflowInputBudget(circular);

    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.error).toContain("not JSON-serializable");
    expect(checkWorkflowInputBudget("short string").ok).toBe(true);
    expect(checkWorkflowInputBudget(undefined).ok).toBe(true);
  });
});
