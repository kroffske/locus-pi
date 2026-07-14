import type { ExtensionAPI, ExtensionContext, ModelLike, ThinkingLevel } from "./pi-api.js";
import type { ModelRoleAssignment } from "./model-settings.js";
import { parseModelSelector } from "./model-settings.js";

export interface LiveModelDisplay {
  model?: string;
  thinking?: ThinkingLevel;
}

export function resolveLiveModelDisplay(input: {
  pi?: Pick<ExtensionAPI, "getThinkingLevel">;
  ctx?: Pick<ExtensionContext, "model">;
  requestedModel?: string | undefined;
  assignment?: ModelRoleAssignment | undefined;
}): LiveModelDisplay | undefined {
  const requested = input.requestedModel === undefined ? undefined : parseModelSelector(input.requestedModel);
  const currentModel = modelSelectorFromModel(input.ctx?.model);
  const currentThinking = input.pi?.getThinkingLevel?.();
  const model = requested?.model ?? currentModel ?? input.assignment?.model;
  const thinking = requested?.thinking ?? currentThinking ?? input.assignment?.thinking;
  if (model === undefined && thinking === undefined) return undefined;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

export function modelSelectorFromModel(model: unknown): string | undefined {
  if (!isModelLike(model)) return undefined;
  const provider = cleanSelectorPart(model.provider);
  const id = cleanSelectorPart(model.id);
  if (id === "") return undefined;
  if (id.includes("/")) return id;
  return provider === "" ? id : `${provider}/${id}`;
}

function isModelLike(value: unknown): value is ModelLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const model = value as { provider?: unknown; id?: unknown };
  return typeof model.provider === "string" && typeof model.id === "string";
}

function cleanSelectorPart(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}
