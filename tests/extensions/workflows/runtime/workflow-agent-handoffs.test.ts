import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  createWorkflowRuntime,
  type WorkflowAgentHandoffOptions,
  type WorkflowAgentOptions,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";

function scriptedRuntime(runId: string, answers: string[]) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      const text = answers[requests.length - 1] ?? answers.at(-1) ?? "";
      return { ok: true, status: "completed", summary: "done", text, diagnostics: [], agent: request.agent };
    },
  });
  return { ...runtime, requests };
}

describe("agent({ handoffs }) dynamic decomposition", () => {
  it("returns bounded complete text handoffs through the existing schema journal path", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-handoffs-happy", [
      '["DAG ID: daily-sales\\nSource: dags/daily.py", "DAG ID: weekly-sales\\nSource: dags/weekly.py"]',
    ]);

    const handoffs = await dsl.agent("Discover every DAG.", {
      handoffs: { minItems: 1, maxItems: 64, maxItemChars: 4_000 },
      tools: ["read", "find"],
    });

    expect(handoffs).toEqual([
      "DAG ID: daily-sales\nSource: dags/daily.py",
      "DAG ID: weekly-sales\nSource: dags/weekly.py",
    ]);
    expect(requests[0]?.prompt).toContain('"type": "array"');
    expect(requests[0]?.prompt).toContain('"maxItems": 64');
    expect(requests[0]?.prompt).toContain('"maxLength": 4000');
    expect(requests[0]?.prompt).toContain('"uniqueTrimmedItems": true');
    expect(getJournal().find((line) => line.kind === "agent_end")?.schemaValidation).toEqual({
      status: "valid",
      attempts: 1,
      errors: [],
    });
  });

  it("allows an empty discovery when minItems is omitted", async () => {
    const { dsl } = scriptedRuntime("agent-handoffs-empty", ["[]"]);
    await expect(dsl.agent("Discover units.", { handoffs: { maxItems: 8 } })).resolves.toEqual([]);
  });

  it("re-asks blank or duplicate handoffs and fails closed after the shared fixed budget", async () => {
    const repaired = scriptedRuntime("agent-handoffs-repair", ['["DAG A", " DAG A "]', '["DAG A", "DAG B"]']);
    await expect(repaired.dsl.agent("Discover.", { handoffs: { maxItems: 8 } })).resolves.toEqual(["DAG A", "DAG B"]);
    expect(repaired.requests).toHaveLength(2);
    expect(repaired.requests[1]?.prompt).toContain('trimmed value "DAG A" duplicates item 0');

    const failed = scriptedRuntime("agent-handoffs-fail", ['["   "]']);
    await expect(failed.dsl.agent("Discover.", { handoffs: { maxItems: 8 } })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    expect(failed.requests).toHaveLength(2);
  });

  it("desugars to the byte-identical request used by the equivalent array schema", async () => {
    const handoffs = scriptedRuntime("agent-handoffs-equivalence", ['["DAG A"]']);
    const schema = scriptedRuntime("agent-schema-equivalence", ['["DAG A"]']);

    await handoffs.dsl.agent("Discover.", {
      handoffs: { minItems: 1, maxItems: 8, maxItemChars: 2_000 },
      label: "discover",
    });
    await schema.dsl.agent("Discover.", {
      schema: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 2_000, nonBlank: true },
        minItems: 1,
        maxItems: 8,
        uniqueTrimmedItems: true,
      },
      label: "discover",
    });

    expect(handoffs.requests).toEqual(schema.requests);
  });

  it.each([
    [{ handoffs: [] }, /agent handoffs must be an object/u],
    [{ handoffs: { minItems: -1, maxItems: 8 } }, /minItems must be a non-negative safe integer/u],
    [{ handoffs: { minItems: 9, maxItems: 8 } }, /minItems cannot exceed maxItems/u],
    [{ handoffs: { maxItems: 0 } }, /maxItems must be a safe integer between 1 and 100/u],
    [{ handoffs: { maxItems: 101 } }, /maxItems must be a safe integer between 1 and 100/u],
    [{ handoffs: { maxItems: 8, maxItemChars: 0 } }, /maxItemChars must be a safe integer between 1 and 32000/u],
    [{ handoffs: { maxItems: 8 }, schema: { type: "array" } }, /cannot be combined with schema/u],
    [{ handoffs: { maxItems: 8 }, validate: () => [] }, /cannot be combined with validate/u],
    [{ handoffs: { maxItems: 8 }, choice: ["a", "b"] }, /choice cannot be combined with handoffs/u],
  ])("rejects malformed declaration %# before any child runs", async (opts, error) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-handoffs-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect((dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("Discover.", opts)).rejects.toThrow(
      error,
    );
    expect(calls).toBe(0);
  });

  it("keeps handoffs out of exact-text option types", () => {
    const handoffOptions: WorkflowAgentHandoffOptions = { handoffs: { maxItems: 8 } };
    expect(handoffOptions.handoffs).toEqual({ maxItems: 8 });

    // @ts-expect-error handoffs selects WorkflowAgentHandoffOptions, never WorkflowAgentOptions
    const invalidTextOptions: WorkflowAgentOptions = { handoffs: { maxItems: 8 } };
    expect(invalidTextOptions).toBeDefined();
  });
});

describe('agent({ handoffs, returnVia: "tool" })', () => {
  function toolRuntime(runId: string, answers: string[]) {
    const requests: WorkflowAgentRequest[] = [];
    const runtime = createWorkflowRuntime({
      runId,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: answers[requests.length - 1] ?? answers.at(-1) ?? "",
          diagnostics: [],
          outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
        };
      },
    });
    return { ...runtime, requests };
  }

  it("desugars to the same array schema and returns the accepted list", async () => {
    const { dsl, requests } = toolRuntime("agent-handoffs-tool", ['["DAG A","DAG B"]']);

    const list: string[] = await dsl.agent("Discover.", {
      label: "discover",
      handoffs: { minItems: 1, maxItems: 8, maxItemChars: 2_000 },
      returnVia: "tool",
    });

    expect(list).toEqual(["DAG A", "DAG B"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.returnContract?.schema).toEqual({
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 2_000, nonBlank: true },
      minItems: 1,
      maxItems: 8,
      uniqueTrimmedItems: true,
    });
  });

  it("refuses bounds violations before any child and off-shape lists at the boundary", async () => {
    const bounded = toolRuntime("agent-handoffs-tool-bounds", ["[]"]);
    for (const maxItems of [101, 0]) {
      await expect(
        (bounded.dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("Discover.", {
          label: "discover",
          handoffs: { maxItems },
          returnVia: "tool",
        }),
      ).rejects.toThrow(/maxItems must be a safe integer between 1 and 100/u);
    }
    expect(bounded.requests).toHaveLength(0);

    const offShape = toolRuntime("agent-handoffs-tool-off-shape", ['["a","b","c"]']);
    await expect(
      offShape.dsl.agent("Discover.", { label: "discover", handoffs: { maxItems: 2 }, returnVia: "tool" }),
    ).rejects.toThrow(SchemaValidationError);
  });

  it("keeps a string output contract out of the shaped handoff options", () => {
    const bad: WorkflowAgentHandoffOptions = {
      handoffs: { maxItems: 2 },
      returnVia: "tool",
      // @ts-expect-error output is a string-only contract; a handoff return carries its shape in handoffs
      output: { type: "string" },
    };
    expect(bad.handoffs).toEqual({ maxItems: 2 });
  });
});
