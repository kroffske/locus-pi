import type { Api, Model } from "@earendil-works/pi-ai";

type ModelConfig = Model<Api>;

/** Single owner for model selector parsing and getModel resolution shared by workflow bridges. */
export function parseModelSelector(selector: string): { provider: string; id: string } | undefined {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return undefined;
  const provider = selector.slice(0, slash);
  const rawId = selector.slice(slash + 1);
  const id = rawId.endsWith(":thinking") ? rawId.slice(0, -":thinking".length) : rawId;
  if (id === "") return undefined;
  return { provider, id };
}

export async function defaultResolveModel(selector: string): Promise<ModelConfig | undefined> {
  const parsed = parseModelSelector(selector);
  if (parsed === undefined) return undefined;
  try {
    const mod = await import("@earendil-works/pi-ai") as { getModel?: (provider: string, id: string) => ModelConfig };
    return mod.getModel?.(parsed.provider, parsed.id);
  } catch {
    return undefined;
  }
}
