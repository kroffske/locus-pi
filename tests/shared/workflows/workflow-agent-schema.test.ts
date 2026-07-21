import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
} as const;

/** Build a runtime whose child answers come from a scripted list; records every request. */
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

describe("agent({ schema }) structured output", () => {
  it("returns the validated value and records a valid shape check on agent_end", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-happy", ['```json\n{"answer":"yes"}\n```']);

    const value = await dsl.agent("Is the diff reviewable?", {
      schema: { ...VERDICT_SCHEMA },
      label: "gate",
    });

    expect(value).toEqual({ answer: "yes" });
    expect(requests).toHaveLength(1);
    // The child is told the contract; the runtime is what enforces it.
    expect(requests[0]?.prompt).toContain("Is the diff reviewable?");
    expect(requests[0]?.prompt).toContain("## Required answer shape");
    expect(requests[0]?.prompt).toContain('"enum"');
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.schemaValidation).toEqual({ status: "valid", attempts: 1, errors: [] });
  });

  it("retries a non-conforming answer with the validator errors and accepts the repaired one", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-retry", [
      '{"answer":"maybe"}',
      '{"answer":"no"}',
    ]);

    const value = await dsl.agent("Is the diff reviewable?", { schema: { ...VERDICT_SCHEMA } });

    expect(value).toEqual({ answer: "no" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toContain("was REJECTED for:");
    expect(requests[1]?.prompt).toContain("not in enum");
    expect(getJournal().flatMap((line) => (line.kind === "agent_end" ? [line.schemaValidation] : []))).toEqual([
      { status: "mismatch", attempts: 1, errors: ['answer: value "maybe" not in enum'] },
      { status: "valid", attempts: 2, errors: [] },
    ]);
  });

  it("fails closed with SchemaValidationError after the retry budget instead of returning text", async () => {
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-fail-closed", ["Probably yes, I think."]);

    let caught: unknown;
    try {
      await dsl.agent("Is the diff reviewable?", { schema: { ...VERDICT_SCHEMA } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SchemaValidationError);
    const failure = caught as SchemaValidationError;
    expect(failure.name).toBe("SchemaValidationError");
    expect(failure.attempts).toBe(2);
    expect(failure.errors.join(" ")).toContain("not valid JSON");
    // Bounded: exactly the retry budget, no unbounded loop, and no value reaches the script.
    expect(requests).toHaveLength(2);
    expect(
      getJournal().every((line) => line.kind !== "agent_end" || line.schemaValidation?.status === "mismatch"),
    ).toBe(true);
  });

  it("propagates a child run failure without spending a schema retry", async () => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-child-failure",
      agentRunner: async (request) => {
        calls += 1;
        return {
          ok: false,
          status: "failed" as const,
          summary: "child exploded",
          diagnostics: ["child exploded"],
          agent: request.agent,
        };
      },
    });

    await expect(dsl.agent("Is the diff reviewable?", { schema: { ...VERDICT_SCHEMA } })).rejects.toThrow(
      /child exploded/u,
    );
    expect(calls).toBe(1);
  });

  it("leaves a call without a schema completely unchanged", async () => {
    const exactText = 'The reviewer says: {"answer":"maybe"} — but this is prose.';
    const { dsl, getJournal, requests } = scriptedRuntime("agent-schema-absent", [exactText]);

    const text = await dsl.agent("Summarize the review.", { label: "summary" });

    expect(text).toBe(exactText);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("Summarize the review.");
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.schemaValidation).toBeUndefined();
  });

  it("rejects a non-object schema before any child runs", async () => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(
      // Workflow scripts are untyped JavaScript; the guard is the runtime's, not the compiler's.
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("shape me", { schema: "not-a-schema" }),
    ).rejects.toThrow(/agent schema must be a JSON-schema object/u);
    expect(calls).toBe(0);
  });
});
