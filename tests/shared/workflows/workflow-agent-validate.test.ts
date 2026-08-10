import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentSchemaOptions,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * `validate` — the script-supplied half of the answer contract.
 *
 * A declared schema says what one node must look like. Referential integrity,
 * agreement between fields, a budget summed across items and the shape of a graph
 * are joins over the whole answer, and until this option existed they were checked
 * by ordinary script code after the await, where the only available verdict was a
 * `throw` that ended the run. Every case here asks the same question from a
 * different side: does a violation the child could have repaired reach the child,
 * and does everything else still fail closed?
 *
 * The never-retryable pin required by the doctrine — host-owned provenance,
 * continuation identity and prior-run text still ending the run without a re-ask —
 * lives with the fixtures that can express it, in
 * `tests/extensions/workflows/review-workflow.test.ts` and
 * `review-remediation-workflows.test.ts`.
 */

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "dependsOn"],
        properties: {
          id: { type: "string", pattern: "^U[1-9][0-9]*$" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** The cross-field rule the schema cannot say: every edge names a declared unit. */
function unknownDependencyErrors(value: unknown): string[] {
  const units = (value as { units: Array<{ id: string; dependsOn: string[] }> }).units;
  const declared = new Set(units.map((unit) => unit.id));
  return units.flatMap((unit, index) =>
    unit.dependsOn.flatMap((dependency, edge) =>
      declared.has(dependency)
        ? []
        : [`units[${index}].dependsOn[${edge}]: value ${JSON.stringify(dependency)} is not a declared unit id`],
    ),
  );
}

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

/** Call the shaped overload with an untyped option bag — workflow scripts are `.mjs`. */
function shaped(dsl: { agent: unknown }, prompt: string, opts: unknown): Promise<unknown> {
  return (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)(prompt, opts);
}

describe("agent({ schema, validate }) script validation", () => {
  it("re-asks the child with every validator error and accepts the repaired answer", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-retry", [
      '{"units":[{"id":"U1","dependsOn":["U7","U8"]}]}',
      '{"units":[{"id":"U1","dependsOn":[]}]}',
    ]);

    const value = await dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors });

    expect(value).toEqual({ units: [{ id: "U1", dependsOn: [] }] });
    expect(requests).toHaveLength(2);
    // Accumulating, not fail-fast: with one retry, reporting only the first
    // violation turns a repairable answer into a fatal one.
    expect(requests[1]?.prompt).toContain('units[0].dependsOn[0]: value "U7" is not a declared unit id');
    expect(requests[1]?.prompt).toContain('units[0].dependsOn[1]: value "U8" is not a declared unit id');
    expect(getJournal().flatMap((line) => (line.kind === "agent_end" ? [line.schemaValidation] : []))).toEqual([
      {
        status: "mismatch",
        attempts: 1,
        source: "script",
        errors: [
          'units[0].dependsOn[0]: value "U7" is not a declared unit id',
          'units[0].dependsOn[1]: value "U8" is not a declared unit id',
        ],
      },
      { status: "valid", attempts: 2, errors: [] },
    ]);
  });

  it("puts script errors in their own labelled block, never in the schema bullet list", async () => {
    // Frozen on first ship: this text enters the attempt-2 prompt and therefore the
    // canonical replay key. Schema errors carry 0-indexed JSON paths and observed
    // values; merging the two lists would hand the child two index bases and frame a
    // cross-field violation as a shape violation.
    const { dsl, requests } = scriptedRuntime("agent-validate-block", ['{"units":[{"id":"U1","dependsOn":["U7"]}]}']);

    await expect(
      dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors }),
    ).rejects.toBeInstanceOf(SchemaValidationError);

    const retry = requests[1]?.prompt ?? "";
    expect(
      retry.endsWith(
        [
          "",
          "",
          "The previous answer (attempt 1 of 3) matched the required shape but was REJECTED by the workflow script for:",
          '- units[0].dependsOn[0]: value "U7" is not a declared unit id',
          "Return the corrected JSON value only.",
        ].join("\n"),
      ),
      retry,
    ).toBe(true);
    expect(retry).not.toContain("was REJECTED for:");
  });

  it("keeps the schema block's own wording when the schema is what rejected", async () => {
    const { dsl, requests } = scriptedRuntime("agent-validate-schema-block", [
      '{"units":[{"id":"nope","dependsOn":[]}]}',
    ]);

    await expect(
      dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors }),
    ).rejects.toBeInstanceOf(SchemaValidationError);

    const retry = requests[1]?.prompt ?? "";
    // Only the rendered budget moves, and it moves because 3 is now the truth.
    expect(retry).toContain("The previous answer (attempt 1 of 3) was REJECTED for:");
    expect(retry).not.toContain("REJECTED by the workflow script");
  });

  it("spends the dedicated third attempt when the schema rejects first and the script second", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-budget", [
      '{"units":[{"id":"nope","dependsOn":[]}]}',
      '{"units":[{"id":"U1","dependsOn":["U7"]}]}',
      '{"units":[{"id":"U1","dependsOn":[]}]}',
    ]);

    // The failure the shared budget produces: a weak model misses the shape on
    // attempt 1, fixes it on attempt 2 and breaks a cross-field rule instead. Under
    // one shared budget the feature never engages and the run costs one extra child.
    const value = await dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors });

    expect(value).toEqual({ units: [{ id: "U1", dependsOn: [] }] });
    expect(requests).toHaveLength(3);
    expect(getJournal().flatMap((line) => (line.kind === "agent_end" ? [line.schemaValidation?.source] : []))).toEqual([
      "schema",
      "script",
      undefined,
    ]);
  });

  it("fails closed with attempts === 3 when the validator rejects every attempt", async () => {
    const { dsl, requests } = scriptedRuntime("agent-validate-exhausted", [
      '{"units":[{"id":"U1","dependsOn":["U7"]}]}',
    ]);

    let caught: unknown;
    try {
      await dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect((caught as SchemaValidationError).attempts).toBe(3);
    expect((caught as SchemaValidationError).errors).toEqual([
      'units[0].dependsOn[0]: value "U7" is not a declared unit id',
    ]);
    expect(requests).toHaveLength(3);
  });

  it("keeps a schema-only call on the old budget and out of the source discriminator", async () => {
    // Outcome 4: nothing about a call that declares no validator changes, including
    // the rendered budget in its repair block — which is in every existing key.
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-absent", [
      '{"units":[{"id":"nope","dependsOn":[]}]}',
    ]);

    await expect(dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA } })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toContain("The previous answer (attempt 1 of 2) was REJECTED for:");
    expect(getJournal().every((line) => line.kind !== "agent_end" || line.schemaValidation?.source === undefined)).toBe(
      true,
    );
  });

  it("ends the run without spending a retry when the validator throws, and journals the author error", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("agent-validate-throws", ['{"units":[]}']);

    await expect(
      dsl.agent("Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        label: "plan",
        validate: () => {
          throw new Error("author bug: cannot read properties of undefined");
        },
      }),
    ).rejects.toThrow("author bug: cannot read properties of undefined");

    // A bug in author code is not a model failure and must not be laundered into a
    // repair loop that blames the model for an exception it cannot fix.
    expect(requests).toHaveLength(1);
    const errors = getJournal().filter((line) => line.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: "script",
      label: "plan",
      message: "author bug: cannot read properties of undefined",
    });
    // The attempt really ran, so it must not leave an agent_start with no record.
    expect(getJournal().filter((line) => line.kind === "agent_end")).toHaveLength(0);
  });

  it("keeps a spent transport attempt readable when the validator then throws", async () => {
    // The same hiding hazard as a thrown transport failure, one layer further in: the
    // attempt that ended the run has no `agent_end`, so its `error` line is the only record
    // that a second child ran at all. Without the attempt trio on it, a reader sees one
    // discarded attempt with no bound and no logical call — ungroupable, and the report
    // drops the whole retry.
    const requests: WorkflowAgentRequest[] = [];
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "agent-validate-throws-after-retry",
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            ok: false,
            status: "failed",
            failureCause: "host-turn-timeout",
            summary: "Child agent turn exceeded its budget and was aborted.",
            diagnostics: [],
            agent: request.agent,
          };
        }
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: '{"units":[]}',
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    await expect(
      shaped(dsl, "Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        label: "plan",
        readOnly: true,
        attempts: 2,
        validate: () => {
          throw new Error("author bug: cannot read properties of undefined");
        },
      }),
    ).rejects.toThrow("author bug: cannot read properties of undefined");

    expect(requests).toHaveLength(2);
    const journal = getJournal();
    const ends = journal.filter((line) => line.kind === "agent_end");
    const errors = journal.filter((line) => line.kind === "error");
    expect(ends.map((line) => [line.callId, line.attempt, line.attempts])).toEqual([["call-0001", 1, 2]]);
    expect(errors.map((line) => [line.callId, line.attempt, line.attempts])).toEqual([["call-0002", 2, 2]]);
    expect(errors[0]?.logicalCallId).toBe(ends[0]?.logicalCallId);
    expect(errors[0]?.logicalCallId).toBeDefined();
  });

  it.each([
    ["a non-array return", () => "nope" as unknown as string[], "agent validate must return an array of strings"],
    ["a non-string element", () => [1] as unknown as string[], "agent validate must return an array of strings"],
    [
      "a Promise",
      () => Promise.resolve([]) as unknown as string[],
      "agent validate must return an array of strings, not a Promise",
    ],
    ["an empty-string error", () => ["ok", ""], "agent validate error at index 1 must be a non-empty string"],
    [
      "more errors than the cap",
      () => Array.from({ length: 33 }, (_, index) => `e${String(index)}`),
      "agent validate returned 33 error(s); at most 32 are allowed",
    ],
    [
      "an error longer than the cap",
      () => ["ok", "x".repeat(501)],
      "agent validate error at index 1 is 501 character(s); at most 500 are allowed",
    ],
  ])("refuses %s instead of truncating or coercing it", async (_case, validate, message) => {
    const { dsl, requests } = scriptedRuntime("agent-validate-return-contract", ['{"units":[]}']);

    await expect(dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate })).rejects.toThrow(message);
    // A run error, never a validation mismatch: truncating would silently rewrite
    // the replay key, and retrying would spend a child on an author bug.
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["a parse failure", "not json at all"],
    ["a schema failure", '{"units":[{"id":"nope","dependsOn":[]}]}'],
  ])("never runs the validator on %s", async (_case, answer) => {
    let validatorCalls = 0;
    const { dsl } = scriptedRuntime(`agent-validate-gated-${_case.replace(/\s/gu, "-")}`, [answer]);

    await expect(
      dsl.agent("Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        validate: () => {
          validatorCalls += 1;
          return [];
        },
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    // Cross-field rules presuppose the shape holds; an off-shape answer would crash
    // author code that destructures it.
    expect(validatorCalls).toBe(0);
  });

  it.each([
    ["an empty answer", "   ", undefined],
    ["an oversized answer", '{"units":[]}', 4],
  ])("never runs the validator on %s", async (_case, answer, maxAnswerChars) => {
    let validatorCalls = 0;
    const { dsl } = scriptedRuntime(`agent-validate-ungated-${_case.replace(/\s/gu, "-")}`, [answer]);

    await expect(
      shaped(dsl, "Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        ...(maxAnswerChars === undefined ? {} : { maxAnswerChars }),
        validate: () => {
          validatorCalls += 1;
          return [];
        },
      }),
    ).rejects.toThrow(/Agent (result text is empty|answer is )/u);
    expect(validatorCalls).toBe(0);
  });

  it.each([
    [{ validate: () => [] }, "agent validate requires a schema"],
    [{ schema: { ...PLAN_SCHEMA }, validate: "not-a-function" }, "agent validate must be a function"],
  ])("refuses a malformed validate declaration before any child runs", async (opts, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-validate-declaration-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(shaped(dsl, "Plan the units.", opts)).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("refuses a nested agent() call from inside the validator", async () => {
    // The validator runs between the child answer and agent_end, before artifact
    // recording and replay journaling, so a nested child call has no defined
    // position in either sequence.
    const { dsl, requests } = scriptedRuntime("agent-validate-reentrant", ['{"units":[]}']);
    let nested: Promise<unknown> | undefined;

    await expect(
      dsl.agent("Plan the units.", {
        schema: { ...PLAN_SCHEMA },
        validate: () => {
          nested = dsl.agent("second opinion");
          return [];
        },
      }),
    ).resolves.toEqual({ units: [] });

    await expect(nested).rejects.toThrow("agent() must not be called from inside a validate callback");
    // The latch is released afterwards, so an ordinary later call still works.
    expect(requests).toHaveLength(1);
    await expect(dsl.agent("later")).resolves.toBe('{"units":[]}');
  });

  it("keeps the validator out of the recorded request so old recordings still replay", async () => {
    // `canonicalAgentRequest` is a JSON.stringify of a fixed field literal, and
    // JSON.stringify drops functions silently — putting `validate` in the key would
    // produce an identical key for two different validators with no divergence
    // signal. It is deliberately absent instead, and its verdict is re-applied to
    // every replayed answer (workflow-replay.test.ts).
    const plain = scriptedRuntime("agent-validate-key-a", ['{"units":[]}']);
    await plain.dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA } });
    const validating = scriptedRuntime("agent-validate-key-b", ['{"units":[]}']);
    await validating.dsl.agent("Plan the units.", { schema: { ...PLAN_SCHEMA }, validate: unknownDependencyErrors });

    expect(validating.requests[0]).toEqual(plain.requests[0]);
    expect(Object.keys(validating.requests[0] ?? {})).not.toContain("validate");
  });

  it("types the validator on the shaped options the Omit widening restores", () => {
    // Without widening `Omit<WorkflowAgentOptions, "schema" | "validate">`, the
    // inherited `never` on the text options would make the feature untypeable. The
    // matching negative pin lives in workflow-agent-schema.test.ts.
    const shapedOptions: WorkflowAgentSchemaOptions = { schema: { type: "string" }, validate: () => [] };
    expect(shapedOptions.validate).toBeTypeOf("function");
  });
});
