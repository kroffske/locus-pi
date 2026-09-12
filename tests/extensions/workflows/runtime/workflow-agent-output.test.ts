import { describe, expect, it } from "vitest";
import {
  createWorkflowAgentOutput,
  type WorkflowAgentOutputDeps,
} from "../../../../extensions/workflows/runtime/workflow-agent-output.js";
import {
  SchemaValidationError,
  type AgentAttemptOutcome,
  type WorkflowAgentAnyOptions,
} from "../../../../extensions/workflows/runtime/workflow-agent-contract.js";
import type { WorkflowJournalLine } from "../../../../extensions/workflows/runtime/workflow-journal-format.js";

/**
 * The shaped-output owner on its own, without the DSL around it.
 *
 * The suites beside this one drive the same behavior through `dsl.agent()`, which is the
 * right level for "what does an author get back". What they cannot show is that this
 * module decides it ALONE: that the acceptance reads the confirmed receipt the logical
 * call carries in `schemaCheck` and never the child's final text, and that every
 * declaration refusal fires here rather than somewhere further down the call.
 */
function outputOwner(runAgentAttempt: WorkflowAgentOutputDeps["runAgentAttempt"]) {
  const journal: WorkflowJournalLine[] = [];
  const owner = createWorkflowAgentOutput({
    runId: "agent-output",
    now: () => "2026-01-01T00:00:00.000Z",
    emit: (line) => {
      journal.push(line);
    },
    currentPhase: () => undefined,
    branchContext: () => undefined,
    activeGroupFields: () => ({}),
    runScriptValidate: (run) => run(),
    runAgentAttempt,
  });
  return { owner, journal };
}

/** A logical call that must never be reached: every case below refuses before it runs. */
const neverRuns: WorkflowAgentOutputDeps["runAgentAttempt"] = async () => {
  throw new Error("the logical call must not run for a refused declaration");
};

function accepted(value: unknown, text = "ignored final text"): AgentAttemptOutcome {
  return {
    text,
    callId: "call-0001",
    replayed: false,
    outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
    schemaCheck: { value, validation: { status: "valid", attempts: 1, errors: [] } },
  };
}

describe("workflow agent output — declaration dispatch", () => {
  it.each<[string, WorkflowAgentAnyOptions | undefined]>([
    ["no options at all", undefined],
    ["an empty declaration", {}],
    ["execution axes only", { label: "review", attempts: 2, timeoutMs: 1_000 }],
    ["an observed report", { result: "report" }],
  ])("routes %s to the plain path", (_name, opts) => {
    const { owner } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape(opts)).toBe("plain");
  });

  it.each<[string, WorkflowAgentAnyOptions]>([
    ["choice", { choice: ["accept", "revise"] }],
    ["handoffs", { handoffs: { minItems: 1 } }],
    ["schema", { schema: { type: "string" } }],
    ["output", { output: { type: "string" as const } }],
    // `repair` declares the clarification allowance of a contract, so it is a shaped
    // declaration on its own: routing it to the plain path would apply it to nothing.
    ["repair alone", { repair: { maxAttempts: 2 } } as WorkflowAgentAnyOptions],
  ])("routes %s to the shaped path", (_name, opts) => {
    const { owner } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape(opts)).toBe("shaped");
  });

  it.each<[WorkflowAgentAnyOptions, string]>([
    [{ maxAnswerChars: 400 } as WorkflowAgentAnyOptions, "agent maxAnswerChars was removed"],
    [{ schemaMaxLength: 400 } as WorkflowAgentAnyOptions, "agent schemaMaxLength was removed"],
    [{ result: "summary" } as WorkflowAgentAnyOptions, "agent result must be report when supplied"],
    [
      { result: "report", schema: { type: "string" } } as WorkflowAgentAnyOptions,
      "agent result: report cannot be combined with schema",
    ],
    [{ choiceFallback: "accept" } as WorkflowAgentAnyOptions, "agent choiceFallback requires choice"],
    [{ validate: () => [] } as WorkflowAgentAnyOptions, "agent validate requires a schema or handoffs"],
    [
      { returnVia: "text", schema: { type: "string" } } as WorkflowAgentAnyOptions,
      'agent returnVia: "text" was removed',
    ],
  ])("refuses %o at dispatch", (opts, message) => {
    const { owner } = outputOwner(neverRuns);
    expect(() => owner.dispatchWorkflowAgentShape(opts)).toThrow(message);
  });

  it('reports returnVia: "tool" as redundant rather than refusing it', () => {
    const { owner, journal } = outputOwner(neverRuns);
    expect(owner.dispatchWorkflowAgentShape({ returnVia: "tool", schema: { type: "string" } })).toBe("shaped");
    expect(journal.map((line) => line.message)).toEqual([
      expect.stringContaining('agent returnVia: "tool" is redundant and ignored') as string,
    ]);
  });
});

describe("workflow agent output — mutually exclusive shapes", () => {
  it.each<[WorkflowAgentAnyOptions, string]>([
    [
      { handoffs: { minItems: 1 }, schema: { type: "array" } } as WorkflowAgentAnyOptions,
      "agent handoffs cannot be combined with schema",
    ],
    [
      { choice: ["a", "b"], handoffs: { minItems: 1 } } as WorkflowAgentAnyOptions,
      "agent choice cannot be combined with handoffs",
    ],
    [
      { choice: ["a", "b"], schema: { type: "string" } } as WorkflowAgentAnyOptions,
      "agent choice cannot be combined with schema",
    ],
    [
      { output: { type: "string" as const }, choice: ["a", "b"] } as WorkflowAgentAnyOptions,
      "agent output is a string-only contract and cannot be combined with choice, schema or handoffs",
    ],
    [
      { output: { type: "string" as const }, schema: { type: "string" } } as WorkflowAgentAnyOptions,
      "agent output is a string-only contract and cannot be combined with choice, schema or handoffs",
    ],
    [
      { output: { type: "string" as const }, handoffs: { minItems: 1 } } as WorkflowAgentAnyOptions,
      "agent output is a string-only contract and cannot be combined with choice, schema or handoffs",
    ],
    [
      { validate: () => [], output: { type: "string" as const } } as WorkflowAgentAnyOptions,
      "agent validate requires a schema or handoffs",
    ],
    [{ validate: "not a function", schema: { type: "string" } } as unknown as WorkflowAgentAnyOptions, "agent validate must be a function"], // prettier-ignore
  ])("refuses %o before the child starts", async (opts, message) => {
    const { owner } = outputOwner(neverRuns);
    await expect(owner.runShapedAgent("decide", opts)).rejects.toThrow(message);
  });
});

describe("workflow agent output — acceptance comes from the receipt", () => {
  it("returns the value the confirmed receipt carried, not the child's final text", async () => {
    const { owner } = outputOwner(async () => accepted({ verdict: "accept" }, '{"verdict":"revise"}'));
    await expect(owner.runShapedAgent("decide", { schema: { type: "object" } })).resolves.toEqual({
      verdict: "accept",
    });
  });

  it("fails closed when the call carries no verdict at all", async () => {
    // An answer that never reached `workflow_return` leaves `schemaCheck` unset. There is
    // nothing to parse it out of the text with, and nothing here tries.
    const { owner } = outputOwner(async () => ({
      text: '{"verdict":"accept"}',
      callId: "call-0001",
      replayed: false,
    }));
    await expect(owner.runShapedAgent("decide", { schema: { type: "object" } })).rejects.toThrow(
      new SchemaValidationError(["missing output validation"], 1),
    );
  });

  it("refuses a string contract whose receipt carried a non-string value", async () => {
    const { owner } = outputOwner(async () => accepted({ verdict: "accept" }));
    await expect(owner.runShapedAgent("summarize", { output: { type: "string" as const } })).rejects.toBeInstanceOf(
      SchemaValidationError,
    );
  });

  it("journals the choice decision from the accepted value and the receipt's attempts", async () => {
    const { owner, journal } = outputOwner(async () => accepted("revise"));
    await expect(owner.runShapedAgent("decide", { choice: ["accept", "revise"], label: "gate" })).resolves.toBe(
      "revise",
    );
    const decision = journal.find((line) => line.message === "[workflow:choice]");
    expect(decision?.choiceDecision).toEqual({ value: "revise", source: "validated", returnVia: "tool", attempts: 1 });
    expect(decision?.label).toBe("gate");
    expect(decision?.callId).toBe("call-0001");
  });
});
