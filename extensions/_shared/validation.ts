import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolResult } from "./pi-api.js";
import { errorResult } from "./pi-api.js";

export function validateParams<T extends TSchema>(schema: T, params: unknown): { ok: true; value: Static<T> } | { ok: false; result: ToolResult } {
  const errors = [...Value.Errors(schema, params)];
  if (errors.length !== 0) {
    return {
      ok: false,
      result: errorResult(
        `Validation failed:\n${errors.map((error) => `- ${error.path || "/"}: ${error.message}`).join("\n")}`,
        { errors: errors.map((error) => ({ path: error.path || "/", message: error.message })) },
      ),
    };
  }
  return { ok: true, value: params as Static<T> };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
