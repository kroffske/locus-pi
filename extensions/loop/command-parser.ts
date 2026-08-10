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
    source: source as "goal" | "review",
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
