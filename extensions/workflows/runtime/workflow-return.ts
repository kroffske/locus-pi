import type { AgentResponseAcceptance } from "../../_shared/agent-runtime/agent-runner.js";
import type { ReadOnlyAgentCustomTool } from "../../_shared/agent-runtime/agent-read-only-policy.js";
import { assertSupportedAgentSchema, isRecord, validateAgainstSchema } from "./workflow-schema.js";
/** Explicit output boundary, independent of semantic review and transport retries. */
export interface WorkflowStringOutput {
  type: "string";
  singleLine?: boolean;
  maxLength?: number;
}
export interface WorkflowOutputRepair {
  /** Includes the first submission or missing-submission turn. Does not start a fresh child. */
  maxAttempts: number;
  clarification?: string;
}
export interface WorkflowReturnContract {
  version: 1;
  choices?: readonly string[];
  /** Supported JSON-schema subset for a shaped value; handoffs arrive already desugared
   *  to a bounded unique string array. */
  schema?: Record<string, unknown>;
  singleLine: boolean;
  maxLength: number;
  maxAttempts: number;
  clarification?: string;
}
export function normalizeWorkflowReturnContract(input: {
  output?: WorkflowStringOutput;
  choices?: readonly string[];
  schema?: unknown;
  /** Runtime-derived canonical JSON allowance for explicitly enlarged handoffs. */
  schemaMaxLength?: number;
  repair?: WorkflowOutputRepair;
}): WorkflowReturnContract {
  if ([input.output, input.choices, input.schema].filter((part) => part !== undefined).length !== 1)
    throw new Error("returnVia: tool requires exactly one choice, string output or schema contract");
  if (input.schema !== undefined) {
    if (!isRecord(input.schema)) throw new Error("agent schema must be a JSON-schema object");
    assertSupportedAgentSchema(input.schema);
  }
  if (
    input.output !== undefined &&
    (!isRecord(input.output) ||
      input.output.type !== "string" ||
      Object.keys(input.output).some((key) => !["type", "singleLine", "maxLength"].includes(key)))
  ) {
    throw new Error("output requires a closed string contract: type, singleLine, maxLength");
  }
  if (input.output?.singleLine !== undefined && typeof input.output.singleLine !== "boolean")
    throw new Error("output.singleLine must be boolean");
  const maxLength = input.output?.maxLength ?? input.schemaMaxLength ?? 100_000;
  if (
    input.schemaMaxLength !== undefined &&
    (input.schema === undefined || !Number.isSafeInteger(input.schemaMaxLength) || input.schemaMaxLength < 1)
  )
    throw new Error("schemaMaxLength requires a schema and a positive safe integer");
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || (input.schemaMaxLength === undefined && maxLength > 500_000))
    throw new Error("output.maxLength must be in 1..500000");
  if (
    input.repair !== undefined &&
    (!isRecord(input.repair) ||
      !Object.hasOwn(input.repair, "maxAttempts") ||
      Object.keys(input.repair).some((key) => !["maxAttempts", "clarification"].includes(key)))
  ) {
    throw new Error("repair requires maxAttempts and optional clarification");
  }
  const maxAttempts = input.repair?.maxAttempts ?? 2;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
    throw new Error("repair.maxAttempts must be in 1..3, including the initial answer");
  const clarification = input.repair?.clarification;
  if (
    clarification !== undefined &&
    (typeof clarification !== "string" || clarification.trim() === "" || clarification.length > 4000)
  )
    throw new Error("repair.clarification must be nonblank text of at most 4000 characters");
  return Object.freeze({
    version: 1,
    ...(input.choices === undefined ? {} : { choices: Object.freeze([...input.choices]) }),
    ...(input.schema === undefined ? {} : { schema: input.schema as Record<string, unknown> }),
    singleLine: input.output?.singleLine ?? false,
    maxLength,
    maxAttempts,
    ...(clarification === undefined ? {} : { clarification }),
  });
}
export function workflowReturnValueError(value: unknown, contract: WorkflowReturnContract): string | undefined {
  if (contract.schema !== undefined) {
    const shape = validateAgainstSchema(value, contract.schema);
    if (!shape.ok) return shape.errors.join("; ");
    // The same size boundary the string contract enforces in-session, measured on the bytes
    // that actually travel: without it an oversized record would only fail after the child
    // completed, outside any repair the child could still do.
    if (JSON.stringify(value).length > contract.maxLength) return `value exceeds ${contract.maxLength} characters`;
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return "value must be a nonblank string";
  if (value.length > contract.maxLength) return `value exceeds ${contract.maxLength} characters`;
  if (contract.singleLine && /[\r\n\u2028\u2029]/u.test(value)) return "value must contain one line only";
  if (contract.choices !== undefined && !contract.choices.includes(value))
    return `value must exactly match one of ${JSON.stringify(contract.choices)}`;
  return undefined;
}
export function workflowReturnInstructions(contract: WorkflowReturnContract): string {
  return (
    `Return the value using workflow_return({ value: ... }), not by formatting a final message. The host validates this contract: ${JSON.stringify(contract)}. ` +
    "Do all research before submitting. After submitting, use only workflow_return to correct the answer; do not repeat file writes or other " +
    "external effects. Finish the turn normally after acceptance." +
    // The prompt is part of the replay key, so a string or choice contract keeps its 0.7.0 bytes.
    (contract.schema === undefined
      ? ""
      : " For a schema or handoffs contract, pass the JSON value itself (object or array) as value, not a string that contains JSON.")
  );
}

/** Syntax guidance only: the agent keeps its content and still has to satisfy the schema. */
function workflowReturnCorrectionExample(contract: WorkflowReturnContract, value: unknown): string {
  const type = contract.schema?.type;
  if (type !== "array" && type !== "object") return "";
  if (type === "array" ? Array.isArray(value) : isRecord(value)) return "";
  const example = type === "array" ? '{"value":[]}' : '{"value":{}}';
  return (
    ` Raw ${type} tool-argument syntax: ${example}. This shows the container only; ` +
    "fill it with your existing schema-matching content. Pass value directly, without JSON.stringify or wrapping the JSON in quotes."
  );
}
/** The accepted proposal becomes authoritative ONLY after the enclosing child completes successfully. */
export function createWorkflowReturnController(contract: WorkflowReturnContract): {
  tool: ReadOnlyAgentCustomTool;
  acceptance: AgentResponseAcceptance;
} {
  let attempts = 0;
  let accepted: unknown;
  let failure: string | undefined;
  let lastError = "workflow_return was not called";
  let correctionExample = "";
  let narrowTools: (() => void) | undefined;
  const reject = (reason: string): void => {
    lastError = reason;
    if (attempts >= contract.maxAttempts) failure = `Output contract exhausted after ${attempts} attempts: ${reason}`;
  };
  const tool: ReadOnlyAgentCustomTool = {
    name: "workflow_return",
    label: "Return workflow value",
    description: workflowReturnInstructions(contract),
    // Value validation belongs to execute, so invalid values receive feedback in THIS session.
    parameters: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
    execute(_toolCallId, input, signal) {
      if (signal.aborted)
        return { content: [{ type: "text", text: "Workflow call cancelled; no value accepted." }], isError: true };
      // Changes apply to the next model turn. Already-dispatched effects are not rolled back.
      narrowTools?.();
      if (failure !== undefined) return { content: [{ type: "text", text: failure }], isError: true };
      const shapeError =
        !isRecord(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "value")
          ? "Provide exactly { value: ... }"
          : undefined;
      const value = isRecord(input) ? input.value : undefined;
      const error = shapeError ?? workflowReturnValueError(value, contract);
      if (accepted !== undefined) {
        if (error === undefined && JSON.stringify(value) === JSON.stringify(accepted))
          return { content: [{ type: "text", text: "Identical proposal already accepted. Finish normally." }] };
        failure = "Conflicting workflow_return after an accepted proposal";
        return { content: [{ type: "text", text: failure }], isError: true };
      }
      attempts += 1;
      if (error !== undefined) {
        reject(error);
        correctionExample = workflowReturnCorrectionExample(contract, value);
        return {
          content: [
            {
              type: "text",
              text: failure ?? `${error}. Correct workflow_return only; do not redo the task.${correctionExample}`,
            },
          ],
          isError: true,
        };
      }
      accepted = value;
      return {
        content: [
          {
            type: "text",
            text: "Proposal accepted. Finish normally; success is committed only after this child completes.",
          },
        ],
        details: { accepted: true, attempts },
      };
    },
  };
  const acceptance: AgentResponseAcceptance = {
    toolNames: ["workflow_return"],
    bindToolRestriction(restrict) {
      narrowTools = restrict;
    },
    inspect() {
      if (failure !== undefined)
        return {
          status: "failed",
          reason: failure,
          failureCause: accepted === undefined ? "output-contract-exhausted" : "output-contract-conflict",
        };
      if (accepted !== undefined)
        return { status: "accepted", text: JSON.stringify(accepted), attempts, toolName: "workflow_return" };
      // An invalid tool call has already spent an attempt. A turn with no call spends one here.
      if (lastError === "workflow_return was not called") attempts += 1;
      reject(lastError);
      if (failure !== undefined)
        return {
          status: "failed",
          reason: failure,
          failureCause: accepted === undefined ? "output-contract-exhausted" : "output-contract-conflict",
        };
      const prompt = `${lastError}. Call workflow_return with the corrected value only. Reuse your existing evidence; do not perform the task again. ${contract.clarification ?? ""}${correctionExample}`;
      lastError = "workflow_return was not called";
      return { status: "retry", prompt };
    },
  };
  return { tool, acceptance };
}
