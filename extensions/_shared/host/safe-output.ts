import { OUTPUT_DEFAULTS } from "../types.js";
import { redactSecrets } from "./redaction.js";

export interface TruncateResult {
  truncated: boolean;
  text: string;
}

export function truncateOutput(
  text: string,
  maxBytes: number = OUTPUT_DEFAULTS.maxBytes,
  maxLines: number = OUTPUT_DEFAULTS.maxLines,
): TruncateResult {
  const lines = text.split(/\r?\n/);
  let bounded =
    lines.length > maxLines
      ? `${lines.slice(0, maxLines).join("\n")}\n[TRUNCATED:lines ${lines.length - maxLines}]`
      : text;
  const bytes = Buffer.byteLength(bounded, "utf8");
  if (bytes <= maxBytes) return { truncated: bounded !== text, text: bounded };
  let end = Math.max(0, maxBytes - 64);
  while (Buffer.byteLength(bounded.slice(0, end), "utf8") > maxBytes - 64 && end > 0) end -= 32;
  bounded = `${bounded.slice(0, end)}\n[TRUNCATED:bytes ${bytes - end}]`;
  return { truncated: true, text: bounded };
}

export function safeToolText(
  text: string,
  maxBytes = OUTPUT_DEFAULTS.maxBytes,
): { text: string; truncated: boolean; redacted: boolean } {
  const redacted = redactSecrets(text);
  const truncated = truncateOutput(redacted.text, maxBytes);
  return { text: truncated.text, truncated: truncated.truncated, redacted: redacted.redacted };
}
