/**
 * extensions/loop/command-parser.ts — Pure text → intent for the loop surface.
 *
 * Two grammars, both Pi-free so they can be exercised without a host: the
 * `/loop` argument string (`parseLoopCommand`) and the free-text the bare
 * `/loop` dialog submits (`parseLoopInput`).
 */

export type LoopCommandParse =
  | { action: "input" }
  | { action: "help" }
  | { action: "status" }
  | { action: "stop"; reason?: string }
  | { action: "start"; source: "goal" | "workflow"; runId?: string; prompt?: string }
  | { action: "until"; source: "goal" | "workflow"; runId?: string; condition?: string }
  | { action: "once"; source?: string; runId?: string; prompt?: string }
  | { action: "unsupported"; value: string };

export type LoopInputParse =
  | { ok: true; source: "goal"; prompt?: string }
  | { ok: true; source: "workflow"; runId: string; prompt?: string }
  | { ok: false; reason: string };

export function parseLoopCommand(raw: string): LoopCommandParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { action: "input" };
  if (trimmed === "status") return { action: "status" };
  if (trimmed === "help" || trimmed === "?") return { action: "help" };
  const [action, ...rest] = trimmed.split(/\s+/);
  if (action === "stop") {
    const reason = rest.join(" ");
    return { action: "stop", ...(reason ? { reason } : {}) };
  }
  if (action === "start" || action === "until") {
    const [source, maybeRunId, ...tail] = rest;
    if (source !== "goal" && source !== "workflow") return { action: "unsupported", value: trimmed };
    if (source === "workflow") {
      const value = tail.join(" ");
      return action === "start"
        ? { action, source, ...(maybeRunId ? { runId: maybeRunId } : {}), ...(value ? { prompt: value } : {}) }
        : { action, source, ...(maybeRunId ? { runId: maybeRunId } : {}), ...(value ? { condition: value } : {}) };
    }
    const value = [maybeRunId, ...tail].filter(Boolean).join(" ");
    return action === "start"
      ? { action, source, ...(value ? { prompt: value } : {}) }
      : { action, source, ...(value ? { condition: value } : {}) };
  }
  if (action !== "once") return { action: "unsupported", value: action ?? "" };
  const [source, maybeRunId, ...promptParts] = rest;
  if (source === undefined) return { action: "once" };
  if (source === "workflow") {
    return {
      action: "once",
      source,
      ...(maybeRunId !== undefined ? { runId: maybeRunId } : {}),
      prompt: promptParts.join(" "),
    };
  }
  return {
    action: "once",
    source,
    prompt: [maybeRunId, ...promptParts].filter(Boolean).join(" "),
  };
}

export function parseLoopInput(raw: string): LoopInputParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "enter goal or workflow source" };
  const [source, ...rest] = trimmed.split(/\s+/u);
  if (source === "goal") {
    const prompt = rest.join(" ").trim();
    return { ok: true, source: "goal", ...(prompt === "" ? {} : { prompt }) };
  }
  if (source === "workflow") {
    const [runId, ...promptParts] = rest;
    if (runId === undefined || runId.trim() === "") {
      return { ok: false, reason: "workflow requires a run id" };
    }
    const prompt = promptParts.join(" ").trim();
    return { ok: true, source: "workflow", runId, ...(prompt === "" ? {} : { prompt }) };
  }
  return { ok: false, reason: "use goal or workflow source" };
}
