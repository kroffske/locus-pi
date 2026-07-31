/**
 * Project-local operator configuration for the direct Fusion surface.
 *
 * The Workflow DSL remains call-site configured. This file owns only the
 * reusable `/fusion` + `fusion` tool defaults for one project. Runtime state
 * lives under `.pi/`, so it is neither committed nor packed as user data.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext, ModelLike } from "../_shared/host/pi-api.js";
import { getProjectRoot } from "../_shared/host/pi-api.js";
import {
  WORKFLOW_FUSION_MAX_MEMBERS,
  WORKFLOW_FUSION_MIN_MEMBERS,
  type WorkflowFusionMember,
} from "./runtime/workflow-runtime.js";

export const FUSION_TOOL_NAME = "fusion";
export const FUSION_CONFIG_VERSION = 1;

export interface FusionConfig {
  version: typeof FUSION_CONFIG_VERSION;
  enabled: boolean;
  members: string[];
  judge?: string;
}

export interface AvailableFusionModel {
  selector: string;
  label: string;
}

export interface ValidatedFusionConfig {
  enabled: boolean;
  members: WorkflowFusionMember[];
  judge: { model: string; label: string };
}

export function defaultFusionConfig(): FusionConfig {
  return { version: FUSION_CONFIG_VERSION, enabled: false, members: [] };
}

export function fusionConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".pi", "locus-pi", "fusion", "config.json");
}

export async function loadFusionConfig(ctx: ExtensionContext): Promise<FusionConfig> {
  try {
    const raw = await readFile(fusionConfigPath(getProjectRoot(ctx)), "utf8");
    const parsed = parseFusionConfig(JSON.parse(raw) as unknown);
    if (parsed === undefined) throw new Error("Fusion config file is invalid.");
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return defaultFusionConfig();
    throw error;
  }
}

export async function saveFusionConfig(ctx: ExtensionContext, config: FusionConfig): Promise<void> {
  const normalized = normalizeStoredFusionConfig(config);
  const configPath = fusionConfigPath(getProjectRoot(ctx));
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function availableFusionModels(ctx: ExtensionContext): Promise<AvailableFusionModel[]> {
  const registry = ctx.modelRegistry;
  if (registry === undefined) return [];
  const models = await (registry.getAvailable?.() ?? registry.getAll?.() ?? []);
  const bySelector = new Map<string, AvailableFusionModel>();
  for (const model of models) {
    const selector = concreteModelSelector(model);
    if (selector === undefined || bySelector.has(selector)) continue;
    const displayName = typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : model.id;
    bySelector.set(selector, { selector, label: `${displayName} · ${selector}` });
  }
  return [...bySelector.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function validateFusionConfig(
  config: FusionConfig,
  available: readonly AvailableFusionModel[],
): ValidatedFusionConfig {
  if (config.members.length < WORKFLOW_FUSION_MIN_MEMBERS || config.members.length > WORKFLOW_FUSION_MAX_MEMBERS) {
    throw new Error(
      `Fusion requires ${WORKFLOW_FUSION_MIN_MEMBERS}-${WORKFLOW_FUSION_MAX_MEMBERS} member models; configured ${config.members.length}.`,
    );
  }
  const memberSet = new Set(config.members);
  if (memberSet.size !== config.members.length) throw new Error("Fusion member models must be unique.");
  const judge = config.judge?.trim();
  if (judge === undefined || judge === "") throw new Error("Fusion judge model is not configured.");
  if (memberSet.has(judge)) throw new Error("Fusion judge must be different from every member model.");

  const availableSet = new Set(available.map((model) => model.selector));
  if (availableSet.size === 0) throw new Error("Pi exposes no configured models to Fusion.");
  const unavailable = [...config.members, judge].filter((selector) => !availableSet.has(selector));
  if (unavailable.length > 0) {
    throw new Error(`Fusion model(s) are not currently available: ${unavailable.join(", ")}.`);
  }

  return {
    enabled: config.enabled,
    members: config.members.map((model, index) => ({
      label: `member-${String(index + 1).padStart(2, "0")}`,
      model,
    })),
    judge: { model: judge, label: "judge" },
  };
}

export function parseFusionSetArgs(input: string): Pick<FusionConfig, "members" | "judge"> {
  const tokens = input.trim().split(/\s+/u).filter(Boolean);
  let membersText: string | undefined;
  let judge: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--members") {
      membersText = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token === "--judge") {
      judge = tokens[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown /fusion set argument: ${token}`);
  }
  if (membersText === undefined || judge === undefined) {
    throw new Error("Usage: /fusion set --members provider/id,provider/id --judge provider/id");
  }
  const members = membersText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return { members, judge: judge.trim() };
}

function parseFusionConfig(value: unknown): FusionConfig | undefined {
  if (!isRecord(value) || value.version !== FUSION_CONFIG_VERSION || typeof value.enabled !== "boolean") {
    return undefined;
  }
  if (!Array.isArray(value.members) || !value.members.every((entry) => typeof entry === "string")) return undefined;
  if (value.judge !== undefined && typeof value.judge !== "string") return undefined;
  return normalizeStoredFusionConfig({
    version: FUSION_CONFIG_VERSION,
    enabled: value.enabled,
    members: value.members,
    ...(value.judge === undefined ? {} : { judge: value.judge }),
  });
}

function normalizeStoredFusionConfig(config: FusionConfig): FusionConfig {
  const members = config.members.map((value) => value.trim()).filter(Boolean);
  const judge = config.judge?.trim();
  return {
    version: FUSION_CONFIG_VERSION,
    enabled: config.enabled,
    members,
    ...(judge === undefined || judge === "" ? {} : { judge }),
  };
}

function concreteModelSelector(model: ModelLike): string | undefined {
  const provider = model.provider.trim();
  const id = model.id.trim();
  return provider === "" || id === "" ? undefined : `${provider}/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
