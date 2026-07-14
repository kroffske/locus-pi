/**
 * workflow-llm-bridge.test.ts — proves dsl.llm() routing WITHOUT a real provider.
 *
 * Injects a fake `complete` (stands in for pi-ai completeSimple) and a fake
 * `resolveModel`, then asserts createWorkflowLlmRunner:
 *   - resolves the model per-call (selector -> resolveModel) or from ctx.model,
 *   - calls complete() with a tools-less single-user-message Context,
 *   - maps AssistantMessage -> WorkflowLlmResult (text/usage/stopReason),
 *   - fails closed (ok:false, no throw) on model error or unresolved model.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../extensions/_shared/pi-api.js";
import {
  createWorkflowLlmRunner,
  type WorkflowLlmCompleteFn,
  type WorkflowLlmStreamFn,
} from "../../../extensions/_shared/workflow-llm-bridge.js";

interface CompleteCall {
  model: unknown;
  context: { systemPrompt?: string; messages: unknown[]; tools?: unknown };
  options: {
    reasoning?: string;
    signal?: AbortSignal;
    apiKey?: string;
    headers?: Record<string, string | null>;
    env?: Record<string, string>;
  } | undefined;
}

function recordingComplete(reply: Awaited<ReturnType<WorkflowLlmCompleteFn>>): {
  fn: WorkflowLlmCompleteFn;
  calls: CompleteCall[];
} {
  const calls: CompleteCall[] = [];
  const fn: WorkflowLlmCompleteFn = async (model, context, options) => {
    calls.push({ model, context: context as CompleteCall["context"], options });
    return reply;
  };
  return { fn, calls };
}

const okReply = {
  content: [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "hello " },
    { type: "text", text: "world" },
  ],
  usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.002 } },
  stopReason: "stop",
};

describe("workflow-llm-bridge: createWorkflowLlmRunner", () => {
  it("resolves a per-call model, calls complete with a tools-less context, and maps the result", async () => {
    const resolved = { provider: "anthropic", id: "claude-x" };
    const resolveCalls: string[] = [];
    const { fn, calls } = recordingComplete(okReply);
    const ctx = { model: { provider: "session", id: "default" } } as unknown as ExtensionContext;

    const runner = createWorkflowLlmRunner({
      ctx,
      signal: new AbortController().signal,
      resolveModel: (sel) => {
        resolveCalls.push(sel);
        return resolved;
      },
      complete: fn,
    });

    const r = await runner({ prompt: "hi", system: "sys", model: "anthropic/claude-x", reasoning: "low", label: "L" });

    // Routed through complete() with the RESOLVED model.
    expect(resolveCalls).toEqual(["anthropic/claude-x"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(resolved);
    // Tools-less single-user-message context.
    expect(calls[0]!.context.systemPrompt).toBe("sys");
    expect(calls[0]!.context.tools).toBeUndefined();
    expect(calls[0]!.context.messages).toHaveLength(1);
    expect(calls[0]!.context.messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(typeof (calls[0]!.context.messages[0] as { timestamp: unknown }).timestamp).toBe("number");
    // Options carry reasoning + the abort signal.
    expect(calls[0]!.options?.reasoning).toBe("low");
    expect(calls[0]!.options?.signal).toBeInstanceOf(AbortSignal);
    // Mapped result.
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello world");
    expect(r.stopReason).toBe("stop");
    expect(r.usage).toEqual({ input: 10, output: 20, totalTokens: 30, costTotal: 0.002 });
    expect(r.model).toBe("anthropic/claude-x");
    expect(r.label).toBe("L");
  });

  it("uses ctx.model when no per-call model selector is given (resolveModel not called)", async () => {
    const resolveCalls: string[] = [];
    const sessionModel = { provider: "session", id: "default" };
    const { fn, calls } = recordingComplete(okReply);
    const ctx = { model: sessionModel } as unknown as ExtensionContext;

    const runner = createWorkflowLlmRunner({
      ctx,
      signal: new AbortController().signal,
      resolveModel: (sel) => {
        resolveCalls.push(sel);
        return undefined;
      },
      complete: fn,
    });

    const r = await runner({ prompt: "hi" });

    expect(resolveCalls).toEqual([]); // per-call resolver untouched
    expect(calls[0]!.model).toBe(sessionModel);
    expect(r.ok).toBe(true);
    expect(r.model).toBe("session/default"); // built from the model object
  });

  it("resolves Pi request auth for the selected model and forwards it to complete()", async () => {
    const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const authCalls: unknown[] = [];
    const { fn, calls } = recordingComplete(okReply);
    const ctx = {
      model,
      modelRegistry: {
        async getApiKeyAndHeaders(selected: unknown) {
          authCalls.push(selected);
          return {
            ok: true as const,
            apiKey: "oauth-token",
            headers: { "x-auth-route": "codex" },
            env: { OPENAI_BASE_URL: "https://example.invalid" },
          };
        },
      },
    } as unknown as ExtensionContext;
    const runner = createWorkflowLlmRunner({ ctx, signal: new AbortController().signal, complete: fn });

    const r = await runner({ prompt: "hi" });

    expect(r.ok).toBe(true);
    expect(authCalls).toEqual([model]);
    expect(calls[0]!.options).toMatchObject({
      apiKey: "oauth-token",
      headers: { "x-auth-route": "codex" },
      env: { OPENAI_BASE_URL: "https://example.invalid" },
    });
  });

  it("fails closed (ok:false, no throw) when complete() throws", async () => {
    const ctx = { model: { provider: "p", id: "m" } } as unknown as ExtensionContext;
    const runner = createWorkflowLlmRunner({
      ctx,
      signal: new AbortController().signal,
      complete: async () => {
        throw new Error("boom");
      },
    });

    const r = await runner({ prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
    expect(r.stopReason).toBe("error");
    expect(r.diagnostics.join(" ")).toMatch(/boom/);
  });

  it("fails closed before completion when Pi request auth cannot resolve", async () => {
    const { fn, calls } = recordingComplete(okReply);
    const ctx = {
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return { ok: false as const, error: "No API key found for openai-codex" };
        },
      },
    } as unknown as ExtensionContext;
    const runner = createWorkflowLlmRunner({ ctx, signal: new AbortController().signal, complete: fn });

    const r = await runner({ prompt: "x" });

    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.diagnostics).toEqual([
      "Workflow llm bridge: request auth failed: No API key found for openai-codex",
    ]);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when no model resolves (and never calls complete)", async () => {
    const { fn, calls } = recordingComplete(okReply);
    const ctx = {} as unknown as ExtensionContext; // no session model
    const runner = createWorkflowLlmRunner({
      ctx,
      signal: new AbortController().signal,
      resolveModel: () => undefined,
      complete: fn,
    });

    const r = await runner({ prompt: "x", model: "bad/selector" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(" ")).toMatch(/no model resolved/);
    expect(calls).toHaveLength(0);
  });

  it("streams via the injected stream fn, forwards text deltas to onDelta, and maps the final message", async () => {
    const ctx = { model: { provider: "p", id: "m" } } as unknown as ExtensionContext;
    const streamFn: WorkflowLlmStreamFn = () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "Hel" };
        yield { type: "text_delta", delta: "lo" };
        yield { type: "done", message: okReply };
      },
      async result() {
        return okReply;
      },
    });
    // complete must NOT be used on the streaming path.
    const complete: WorkflowLlmCompleteFn = async () => {
      throw new Error("complete should not be called when streaming");
    };
    const runner = createWorkflowLlmRunner({ ctx, signal: new AbortController().signal, complete, stream: streamFn });

    const deltas: string[] = [];
    const r = await runner({ prompt: "write", stream: true, onDelta: (d) => deltas.push(d) });

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("hello world"); // from the final message, not the deltas
    expect(r.usage?.totalTokens).toBe(30);
  });

  it("maps a non-stop/non-length stopReason to ok:false with a diagnostic", async () => {
    const ctx = { model: { provider: "p", id: "m" } } as unknown as ExtensionContext;
    const { fn } = recordingComplete({
      content: [],
      stopReason: "error",
      errorMessage: "context too long",
      usage: { input: 1, output: 0, totalTokens: 1, cost: { total: 0 } },
    });
    const runner = createWorkflowLlmRunner({ ctx, signal: new AbortController().signal, complete: fn });

    const r = await runner({ prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("error");
    expect(r.diagnostics.join(" ")).toMatch(/stopReason=error/);
  });
});
