/**
 * workflow-llm-bridge.ts — Adapter: dsl.llm() -> pi-ai completeSimple (direct model call).
 *
 * Turns a WorkflowLlmRequest into ONE direct model completion via the host's
 * `@earendil-works/pi-ai` `completeSimple` — no child agent session, no tools. The
 * model is resolved by the SAME selector path the agent bridge uses (per-call
 * `getModel(provider,id)` or the session `ctx.model`), so llm() and agent() share one
 * model-routing convention. Before calling pi-ai it resolves the same request auth
 * (`apiKey`, provider/model headers, and provider env) through `ctx.modelRegistry`
 * that Pi uses for its own session calls. `complete` + `resolveModel` are injectable
 * so tests can prove the wiring without a real provider.
 *
 * Fail-closed: a missing model, host-too-old default call path, or model/network
 * error maps to ok:false diagnostics (never a fabricated completion); the runtime
 * decides how to surface it.
 */

import type { ExtensionContext, ModelLike, ModelRequestAuthLike } from "./pi-api.js";
import { defaultResolveModel } from "./workflow-model-resolve.js";
import type {
  WorkflowLlmRunner,
  WorkflowLlmRequest,
  WorkflowLlmResult,
  WorkflowLlmUsage,
} from "./workflow-runtime.js";

// ---------------------------------------------------------------------------
// Minimal structural views of the pi-ai shapes we touch (types are erased at
// runtime; we read only these fields).
// ---------------------------------------------------------------------------

interface PiTextContent {
  type: string;
  text?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiAssistantMessage {
  content?: PiTextContent[];
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

interface PiContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

interface PiCompleteOptions {
  reasoning?: string;
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string | null>;
  env?: Record<string, string>;
}

/** Structural signature of pi-ai `completeSimple(model, context, options?)`. */
export type WorkflowLlmCompleteFn = (
  model: unknown,
  context: PiContext,
  options?: PiCompleteOptions,
) => Promise<PiAssistantMessage>;

/** Structural view of a pi-ai AssistantMessageEvent (only the fields we read). */
interface PiStreamEvent {
  type: string;
  delta?: string;
  message?: PiAssistantMessage; // carried by the terminal "done" event
  error?: PiAssistantMessage;   // carried by the terminal "error" event
}

/** Structural view of pi-ai AssistantMessageEventStream: async-iterable + a result() promise. */
interface PiEventStream extends AsyncIterable<PiStreamEvent> {
  result(): Promise<PiAssistantMessage>;
}

/** Structural signature of pi-ai `streamSimple(model, context, options?)`. */
export type WorkflowLlmStreamFn = (
  model: unknown,
  context: PiContext,
  options?: PiCompleteOptions,
) => PiEventStream;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkflowLlmBridgeOptions {
  ctx: ExtensionContext;          // captured at tool/command execute time (carries the session model)
  signal: AbortSignal;
  /** Per-call selector resolver; defaults to pi-ai getModel (shared convention with the agent bridge). */
  resolveModel?: (selector: string) => unknown;
  /** Injectable completion fn; defaults to pi-ai completeSimple. Tests pass a fake to prove routing. */
  complete?: WorkflowLlmCompleteFn;
  /** Injectable streaming fn; defaults to pi-ai streamSimple. Used when req.stream is set. */
  stream?: WorkflowLlmStreamFn;
}

// ---------------------------------------------------------------------------
// createWorkflowLlmRunner
// ---------------------------------------------------------------------------

/** Builds the WorkflowLlmRunner the runtime depends on for dsl.llm(). */
export function createWorkflowLlmRunner(options: WorkflowLlmBridgeOptions): WorkflowLlmRunner {
  const { ctx, signal } = options;
  const resolveModelFn = options.resolveModel ?? defaultResolveModel;
  const completeFn = options.complete ?? defaultComplete;
  const streamFn = options.stream ?? defaultStream;

  return async function runWorkflowLlm(req: WorkflowLlmRequest): Promise<WorkflowLlmResult> {
    // 1. Resolve the model: per-call selector via resolveModel, else the session model.
    const model =
      req.model !== undefined
        ? await Promise.resolve(resolveModelFn(req.model))
        : (ctx as { model?: unknown }).model;
    const modelSelector = req.model ?? modelSelectorString(model);

    if (model === undefined || model === null) {
      return {
        ok: false,
        text: "",
        stopReason: "error",
        diagnostics: [`Workflow llm bridge: no model resolved (selector=${req.model ?? "session-default"})`],
        ...(modelSelector !== undefined ? { model: modelSelector } : {}),
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }

    // 2. Resolve request auth through Pi's model registry. The session does this
    //    before its own provider calls; direct extension calls must do the same.
    const auth = await resolveRequestAuth(ctx, model);
    if (!auth.ok) {
      return {
        ok: false,
        text: "",
        stopReason: "error",
        diagnostics: [`Workflow llm bridge: request auth failed: ${auth.error}`],
        ...(modelSelector !== undefined ? { model: modelSelector } : {}),
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }

    // 3. Build a tools-less single-user-message context (NO agent session, NO tools).
    const context: PiContext = {
      ...(req.system !== undefined ? { systemPrompt: req.system } : {}),
      messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }],
    };
    const completeOptions: PiCompleteOptions = {
      signal,
      ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
      ...(auth.env !== undefined ? { env: auth.env } : {}),
    };
    if (req.reasoning !== undefined) completeOptions.reasoning = req.reasoning;

    // 4. One direct completion (streaming when requested); map AssistantMessage ->
    //    WorkflowLlmResult. Fail closed on error.
    const useStream = req.stream === true && typeof req.onDelta === "function";
    try {
      const msg = useStream
        ? await consumeStream(streamFn(model, context, completeOptions), req.onDelta!)
        : await completeFn(model, context, completeOptions);
      const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "error";
      const ok = stopReason === "stop" || stopReason === "length";
      const text = extractText(msg);
      const usage = projectUsage(msg.usage);
      return {
        ok,
        text,
        stopReason,
        ...(modelSelector !== undefined ? { model: modelSelector } : {}),
        ...(usage !== undefined ? { usage } : {}),
        diagnostics: ok
          ? []
          : [`model stopReason=${stopReason}${msg.errorMessage !== undefined ? `: ${msg.errorMessage}` : ""}`],
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        text: "",
        stopReason: "error",
        ...(modelSelector !== undefined ? { model: modelSelector } : {}),
        diagnostics: [`Workflow llm bridge: model call failed: ${err instanceof Error ? err.message : String(err)}`],
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRequestAuth(ctx: ExtensionContext, model: unknown): Promise<ModelRequestAuthLike> {
  const registry = ctx.modelRegistry;
  if (typeof registry?.getApiKeyAndHeaders !== "function") {
    // Compatibility for minimal/test hosts and older Pi builds. pi-ai may still
    // resolve environment-native credentials; provider failure remains explicit.
    return { ok: true };
  }
  try {
    return await registry.getApiKeyAndHeaders(model as ModelLike);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Drive a pi-ai event stream: forward text chunks to onDelta, return the final message. */
async function consumeStream(
  stream: PiEventStream,
  onDelta: (textDelta: string) => void,
): Promise<PiAssistantMessage> {
  let finalMsg: PiAssistantMessage | undefined;
  for await (const ev of stream) {
    if (ev.type === "text_delta" && typeof ev.delta === "string") {
      onDelta(ev.delta);
    } else if (ev.type === "done" && ev.message !== undefined) {
      finalMsg = ev.message;
    } else if (ev.type === "error" && ev.error !== undefined) {
      finalMsg = ev.error;
    }
  }
  return finalMsg ?? (await stream.result());
}

function extractText(msg: PiAssistantMessage): string {
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((c): c is PiTextContent => c !== null && typeof c === "object" && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

function projectUsage(usage: PiUsage | undefined): WorkflowLlmUsage | undefined {
  if (usage === undefined || usage === null) return undefined;
  const input = typeof usage.input === "number" ? usage.input : 0;
  const output = typeof usage.output === "number" ? usage.output : 0;
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : input + output;
  const costTotal = typeof usage.cost?.total === "number" ? usage.cost.total : 0;
  return { input, output, totalTokens, costTotal };
}

/** Build a "provider/id" selector string from a resolved model object (best-effort, for display). */
function modelSelectorString(model: unknown): string | undefined {
  if (model === null || typeof model !== "object") return undefined;
  const m = model as { provider?: unknown; id?: unknown };
  const provider = typeof m.provider === "string" ? m.provider : "";
  const id = typeof m.id === "string" ? m.id : "";
  if (id === "") return undefined;
  if (id.includes("/")) return id;
  return provider !== "" ? `${provider}/${id}` : id;
}

const defaultComplete: WorkflowLlmCompleteFn = async (model, context, options) => {
  const mod = (await import("@earendil-works/pi-ai")) as { completeSimple?: WorkflowLlmCompleteFn };
  if (typeof mod.completeSimple !== "function") {
    throw new Error("pi-ai completeSimple is unavailable (host too old)");
  }
  return mod.completeSimple(model, context, options);
};

// pi-ai streamSimple returns the stream synchronously, but our dynamic import is async; this
// adapter lazily imports and forwards iteration + result() onto the real stream.
const defaultStream: WorkflowLlmStreamFn = (model, context, options) => {
  const realStreamP = (async (): Promise<PiEventStream> => {
    const mod = (await import("@earendil-works/pi-ai")) as { streamSimple?: WorkflowLlmStreamFn };
    if (typeof mod.streamSimple !== "function") {
      throw new Error("pi-ai streamSimple is unavailable (host too old)");
    }
    return mod.streamSimple(model, context, options);
  })();
  return {
    async *[Symbol.asyncIterator]() {
      const real = await realStreamP;
      for await (const ev of real) yield ev;
    },
    async result() {
      const real = await realStreamP;
      return real.result();
    },
  };
};
