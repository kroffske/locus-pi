import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  createWorkflowRuntime,
  type WorkflowAgentChoiceOptions,
  type WorkflowAgentOptions,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";

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

describe("agent({ choice }) exact routing output", () => {
  it("returns one declared literal through the existing schema journal path", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-choice-happy", ['"revise"']);

    const decision = await dsl.agent("Choose the next step.", {
      choice: ["accept", "revise", "blocked"] as const,
      tools: [],
      maxToolCalls: 0,
    });
    const typed: "accept" | "revise" | "blocked" = decision;

    expect(typed).toBe("revise");
    expect(requests[0]?.prompt).toContain('"enum": [');
    expect(requests[0]?.prompt).toContain('"blocked"');
    expect(getJournal().find((line) => line.kind === "agent_end")?.schemaValidation).toEqual({
      status: "valid",
      attempts: 1,
      errors: [],
    });
  });

  it("re-asks a non-choice answer and fails closed after the shared fixed budget", async () => {
    const repaired = scriptedRuntime("agent-choice-repair", ['"maybe"', '"accept"']);
    await expect(repaired.dsl.agent("Route.", { choice: ["accept", "revise"] })).resolves.toBe("accept");
    expect(repaired.requests).toHaveLength(2);
    expect(repaired.requests[1]?.prompt).toContain('value "maybe" not in enum');

    const failed = scriptedRuntime("agent-choice-fail", ['"maybe"']);
    await expect(failed.dsl.agent("Route.", { choice: ["accept", "revise"] })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    expect(failed.requests).toHaveLength(2);
  });

  it("desugars to the byte-identical request used by an equivalent string-enum schema", async () => {
    const choice = scriptedRuntime("agent-choice-equivalence", ['"accept"']);
    const schema = scriptedRuntime("agent-schema-equivalence", ['"accept"']);

    await choice.dsl.agent("Route.", { choice: ["accept", "revise"], label: "route" });
    await schema.dsl.agent("Route.", {
      schema: { type: "string", enum: ["accept", "revise"] },
      label: "route",
    });

    expect(choice.requests).toEqual(schema.requests);
  });

  it.each([
    [{ choice: "accept" }, /agent choice must be an array of strings/u],
    [{ choice: ["accept"] }, /agent choice must contain 2-32 values/u],
    [{ choice: ["accept", ""] }, /value at index 1 must be a non-empty string/u],
    [{ choice: ["accept", "accept"] }, /duplicate value "accept"/u],
    [{ choice: ["accept", "revise"], schema: { type: "string" } }, /cannot be combined with schema/u],
    [{ choice: ["accept", "revise"], validate: () => [] }, /cannot be combined with validate/u],
  ])("rejects malformed declaration %# before any child runs", async (opts, error) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-choice-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect((dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("Route.", opts)).rejects.toThrow(
      error,
    );
    expect(calls).toBe(0);
  });

  it("keeps choice out of exact-text and shaped option types", () => {
    const choiceOptions: WorkflowAgentChoiceOptions<["accept", "revise"]> = { choice: ["accept", "revise"] };
    expect(choiceOptions.choice).toEqual(["accept", "revise"]);

    // @ts-expect-error choice selects WorkflowAgentChoiceOptions, never WorkflowAgentOptions
    const invalidTextOptions: WorkflowAgentOptions = { choice: ["accept", "revise"] };
    expect(invalidTextOptions).toBeDefined();
  });

  it("accepts runtime-sized and explicitly annotated choice lists", async () => {
    const runtime = scriptedRuntime("agent-choice-dynamic", ['"accept"', '"revise"']);
    const dynamicValues: string[] = ["accept", "revise"];
    const dynamicResult: string = await runtime.dsl.agent("Route dynamically.", { choice: dynamicValues });

    const annotated: WorkflowAgentChoiceOptions = { choice: ["accept", "revise"] };
    const annotatedResult: string = await runtime.dsl.agent("Route from options.", annotated);

    expect(dynamicResult).toBe("accept");
    expect(annotatedResult).toBe("revise");
  });
});
