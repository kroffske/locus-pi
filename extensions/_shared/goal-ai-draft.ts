import type {
  ExtensionCommandContext,
  ExtensionContext,
  NewSessionResultLike,
  ReplacementSessionContext,
  ReplacementSessionEntryLike,
} from "./host/pi-api.js";
import { getSessionId } from "./host/pi-api.js";

export interface GoalAiDraftResult {
  status: "blocked" | "failed" | "completed" | "cancelled";
  reason: string;
  draft?: string;
  childSessionId?: string;
  renderContext?: ExtensionContext;
}

export function buildGoalAiDraftPrompt(request: string): string {
  return [
    "Turn the user's short request into one standalone Locus Prompt Draft prompt.",
    "",
    "Use this compact contract inspired by locus-prompt-draft:",
    "- Write in the user's language.",
    "- Preserve commands, paths, filenames, schema keys and code identifiers literally.",
    "- Do not execute the underlying work.",
    "- Do not write a detailed implementation plan.",
    "- Do not prepend downstream skill, agent, PM, planner or reviewer calls.",
    "- Keep Task and Draft goal near the top.",
    "- Draft goal must describe the useful working end state.",
    "- Separate in-scope direction from the nearest out-of-scope interpretation.",
    "- Return exactly one prompt and no commentary outside the prompt.",
    "",
    "Required output shape:",
    "",
    "Task:",
    "<short user task>",
    "",
    "Draft goal:",
    "<one paragraph describing the working end state>",
    "",
    "Intent:",
    "<1-3 sentences translating the request>",
    "",
    "Context:",
    "- <only facts that change the direction>",
    "",
    "Draft direction:",
    "- In scope: <primary work direction>",
    "- Out of scope: <closest tempting adjacent interpretation>",
    "- Outcome type: working delivery | decision | evidence | gate - <short why>",
    "",
    "Execution framing:",
    "- Use this prompt as a standalone intent draft.",
    "- Choose implementation, research, review and verification later only if explicitly asked.",
    "- Do not treat intermediate notes as completion unless explicitly requested.",
    "",
    "Expected result:",
    "- <1-2 outcome-level results>",
    "",
    "Final result:",
    "<one sentence naming the usable outcome>",
    "",
    "User request:",
    request,
  ].join("\n");
}

export async function runGoalAiDraftSession(ctx: ExtensionCommandContext, request: string): Promise<GoalAiDraftResult> {
  return runDraftSession(ctx, buildGoalAiDraftPrompt(request), findGoalDraft);
}

export function buildPlanPrompt(request: string): string {
  return [
    "Produce a concrete file-level implementation plan for the user's request.",
    "",
    "Planning contract:",
    "- Read the request as implementation intent.",
    "- Do not execute the work.",
    "- Do not edit files.",
    "- Do not run commands.",
    "- Keep the plan specific enough that a coding agent can implement it.",
    "- Name likely files, tests, and verification steps when they can be inferred.",
    "",
    "Required output shape:",
    "",
    "## Goal",
    "",
    "## Approach",
    "",
    "## Milestones",
    "",
    "## Risks",
    "",
    "## Open Questions",
    "",
    "User request:",
    request,
  ].join("\n");
}

export async function runPlanDraftSession(ctx: ExtensionCommandContext, request: string): Promise<GoalAiDraftResult> {
  return runDraftSession(ctx, buildPlanPrompt(request), findLatestAssistantDraft);
}

async function runDraftSession(
  ctx: ExtensionCommandContext,
  kickoffPrompt: string,
  extractor: (entries: ReplacementSessionEntryLike[]) => string | undefined,
): Promise<GoalAiDraftResult> {
  if (typeof ctx.newSession !== "function") {
    return { status: "blocked", reason: "Replacement-session host is unavailable." };
  }

  let childResult: GoalAiDraftResult | undefined;
  try {
    const sessionResult = await ctx.newSession({
      parentSession: getSessionId(ctx),
      async withSession(replacementCtx) {
        childResult = await runDraftInReplacementSession(replacementCtx, kickoffPrompt, extractor);
      },
    });
    if (isCancelled(sessionResult)) {
      return { status: "cancelled", reason: sessionResult.reason ?? "Replacement-session creation was cancelled." };
    }
    if (childResult !== undefined) return childResult;
    return { status: "failed", reason: "Replacement session finished without captured draft output." };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", reason };
  }
}

async function runDraftInReplacementSession(
  replacementCtx: ReplacementSessionContext,
  kickoffPrompt: string,
  extractor: (entries: ReplacementSessionEntryLike[]) => string | undefined,
): Promise<GoalAiDraftResult> {
  if (typeof replacementCtx.sendUserMessage !== "function") {
    return {
      status: "blocked",
      reason: "Replacement session cannot receive user messages.",
      renderContext: replacementCtx,
      ...childSessionIdField(replacementCtx),
    };
  }

  await replacementCtx.sendUserMessage(kickoffPrompt, { source: "locus-pi-goal-ai" });
  if (typeof replacementCtx.waitForIdle === "function") await replacementCtx.waitForIdle();
  const entries = await readReplacementEntries(replacementCtx);
  if (entries === undefined) {
    return {
      status: "blocked",
      reason: "Replacement session entries are unavailable.",
      renderContext: replacementCtx,
      ...childSessionIdField(replacementCtx),
    };
  }
  const draft = extractor(entries);
  if (draft === undefined) {
    return {
      status: "failed",
      reason: "Replacement session did not return a valid Locus Prompt Draft.",
      renderContext: replacementCtx,
      ...childSessionIdField(replacementCtx),
    };
  }
  return {
    status: "completed",
    reason: "Goal draft completed.",
    draft,
    renderContext: replacementCtx,
    ...childSessionIdField(replacementCtx),
  };
}

async function runGoalAiDraftInReplacementSession(
  replacementCtx: ReplacementSessionContext,
  kickoffPrompt: string,
): Promise<GoalAiDraftResult> {
  return runDraftInReplacementSession(replacementCtx, kickoffPrompt, findGoalDraft);
}

async function readReplacementEntries(
  ctx: ReplacementSessionContext,
): Promise<ReplacementSessionEntryLike[] | undefined> {
  const entries = await ctx.sessionManager?.getEntries?.({ limit: 40 });
  return Array.isArray(entries) ? entries : undefined;
}

function findGoalDraft(entries: ReplacementSessionEntryLike[]): string | undefined {
  const candidates = entries
    .slice()
    .reverse()
    .map(extractEntryText)
    .filter((text): text is string => text !== undefined)
    .map(stripCodeFence)
    .map((text) => text.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (/^Task:\s*/m.test(candidate) && /^Draft goal:\s*/m.test(candidate)) return candidate;
  }
  return undefined;
}

function findLatestAssistantDraft(entries: ReplacementSessionEntryLike[]): string | undefined {
  return entries
    .slice()
    .reverse()
    .filter(isAssistantEntry)
    .map(extractEntryText)
    .filter((text): text is string => text !== undefined)
    .map(stripCodeFence)
    .map((text) => text.trim())
    .find(Boolean);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function extractEntryText(entry: ReplacementSessionEntryLike): string | undefined {
  if (typeof entry.content === "string") return entry.content;
  if (typeof entry.text === "string") return entry.text;
  const messageText = extractTextFromContent(isRecord(entry.message) ? entry.message.content : undefined);
  if (messageText !== undefined) return messageText;
  if (isRecord(entry.payload) && typeof entry.payload.content === "string") return entry.payload.content;
  if (isRecord(entry.data) && typeof entry.data.content === "string") return entry.data.content;
  const payloadText = extractTextFromContent(isRecord(entry.payload) ? entry.payload.content : undefined);
  if (payloadText !== undefined) return payloadText;
  return extractTextFromContent(isRecord(entry.data) ? entry.data.content : undefined);
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    if (typeof part.content === "string") return [part.content];
    return [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}

function childSessionId(ctx: ReplacementSessionContext): string | undefined {
  return ctx.session?.id ?? ctx.sessionManager?.getSessionId?.();
}

function childSessionIdField(ctx: ReplacementSessionContext): { childSessionId: string } | Record<string, never> {
  const id = childSessionId(ctx);
  return id === undefined ? {} : { childSessionId: id };
}

function isAssistantEntry(entry: ReplacementSessionEntryLike): boolean {
  if (entry.role === "assistant") return true;
  if (isRecord(entry.message) && entry.message.role === "assistant") return true;
  if (isRecord(entry.payload) && entry.payload.role === "assistant") return true;
  if (isRecord(entry.data) && entry.data.role === "assistant") return true;
  return false;
}

function isCancelled(result: NewSessionResultLike | undefined): boolean {
  return result?.cancelled === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
