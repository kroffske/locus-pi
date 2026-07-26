import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentOptions,
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

  it("accepts an integer answer and rejects a fractional one with a value-bearing error", async () => {
    const { dsl, requests } = scriptedRuntime("agent-schema-integer", ['{"count":2.5}', '{"count":3}']);

    const value = await dsl.agent("How many blocking findings?", {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["count"],
        properties: { count: { type: "integer" } },
      },
    });

    expect(value).toEqual({ count: 3 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toContain("count: expected integer, got 2.5");
  });

  it("re-asks the child when a size or pattern bound is broken, instead of killing the run", async () => {
    // The whole point of moving bounds into the schema: a script that checked
    // these by hand after validation could only throw, ending the run on an
    // answer the child could have corrected on its own.
    const { dsl, requests } = scriptedRuntime("agent-schema-bounds", [
      '{"id":"w1","tags":["a","b","c"],"summary":""}',
      '{"id":"W1","tags":["a","b"],"summary":"ok"}',
    ]);

    const value = await dsl.agent("Name the unit.", {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "tags", "summary"],
        properties: {
          id: { type: "string", pattern: "^W[1-9][0-9]*$" },
          tags: { type: "array", items: { type: "string" }, maxItems: 2 },
          summary: { type: "string", minLength: 1 },
        },
      },
    });

    expect(value).toEqual({ id: "W1", tags: ["a", "b"], summary: "ok" });
    expect(requests).toHaveLength(2);
    const retry = requests[1]?.prompt ?? "";
    expect(retry).toContain('id: value "w1" does not match pattern ^W[1-9][0-9]*$');
    expect(retry).toContain("tags: expected at most 2 item(s), got 3");
    expect(retry).toContain("summary: expected at least 1 character(s), got 0");
  });

  it.each([
    [{ type: "string", maxLength: 12.5 }, /maxLength must be a non-negative safe integer/u],
    [{ type: "string", maxLength: -1 }, /maxLength must be a non-negative safe integer/u],
    [{ type: "string", minLength: 9, maxLength: 4 }, /minLength 9 exceeds maxLength 4/u],
    [{ type: "array", items: { type: "string" }, minItems: 3, maxItems: 2 }, /minItems 3 exceeds maxItems 2/u],
    [{ type: "object", properties: {}, maxLength: 4 }, /maxLength is only valid for a string schema/u],
    [{ type: "string", maxItems: 4 }, /maxItems is only valid for an array schema/u],
    [{ type: "string", pattern: "(" }, /pattern is not a valid regular expression/u],
    [{ type: "string", pattern: 7 }, /pattern must be a string/u],
    [{ type: "integer", enum: [1, 1.5] }, /enum value at index 1 does not match declared type integer/u],
    [{ type: "object", required: "answer", properties: {} }, /required must be an array/u],
    [{ type: "object", required: ["answer", "answer"], properties: {} }, /required contains duplicate/u],
    [{ type: "object", required: ["missing"], properties: {} }, /not declared in properties/u],
    [{ type: "object", properties: { answer: "string" } }, /properties\.answer must be a schema object/u],
    [{ type: "array" }, /array schema must declare items/u],
    [{ type: "array", items: { type: "string", minItems: 1 } }, /schema\.items: minItems is only valid for an array/u],
    [{ type: "string", additionalProperties: false }, /additionalProperties is only valid/u],
    [{ type: "string", enum: "yes" }, /enum must be a non-empty array/u],
    [{ enum: [{ answer: "yes" }] }, /enum value at index 0 must be a JSON primitive/u],
    [{ enum: [Number.NaN] }, /enum value at index 0 must be a JSON primitive/u],
    [{ type: "string", enum: ["yes", 1] }, /enum value at index 1 does not match declared type string/u],
    [{ type: "object", enum: [null] }, /enum value at index 0 does not match declared type object/u],
  ])("rejects an unsupported or malformed declaration before any child runs", async (schema, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-schema-declaration-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("shape me", { schema }),
    ).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("keeps the text options type unable to carry a schema", () => {
    const textOptions: WorkflowAgentOptions = { label: "text" };
    expect(textOptions).toEqual({ label: "text" });

    // Compile-time contract: adding schema to text options must remain an error.
    // @ts-expect-error schema selects WorkflowAgentSchemaOptions, never WorkflowAgentOptions
    const invalidTextOptions: WorkflowAgentOptions = { schema: { type: "string" } };
    expect(invalidTextOptions).toBeDefined();

    // Same contract for validate: it needs a parsed value, which only the shaped
    // overload has, so a typo cannot silently run unvalidated on the text path.
    // @ts-expect-error validate selects WorkflowAgentSchemaOptions, never WorkflowAgentOptions
    const invalidValidateOptions: WorkflowAgentOptions = { validate: () => [] };
    expect(invalidValidateOptions).toBeDefined();
  });
});
