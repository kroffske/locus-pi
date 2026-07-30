import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const AGENT_CONTEXT_EXTRAS_ENV = "LOCUS_AGENT_CONTEXT_EXTRAS";
export const AGENT_MEMORY_FILE_ENV = "LOCUS_AGENT_MEMORY_FILE";
export const AGENT_PRELOAD_SKILLS_ENV = "LOCUS_AGENT_PRELOAD_SKILLS";

const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 8 * 1024;
const MAX_SKILL_LINES = 200;
const MAX_SKILL_BYTES = 4 * 1024;
const MAX_TOTAL_EXTRAS_BYTES = 16 * 1024;

export interface AgentContextExtrasOptions {
  cwd?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  exists?: (filePath: string) => boolean;
}

export interface AgentContextTextBlock {
  kind: "memory" | "skill";
  requested: string;
  source: string;
  content: string;
  truncated?: boolean;
}

export interface AgentContextExtrasResolution {
  enabled: boolean;
  diagnostics: string[];
  memory?: AgentContextTextBlock;
  skills: AgentContextTextBlock[];
}

export interface AgentSystemPromptExtrasOptions extends AgentContextExtrasOptions {
  diagnostics?: string[];
}

export function resolveAgentContextExtras(options: AgentContextExtrasOptions): AgentContextExtrasResolution {
  const env = options.env ?? process.env;
  const normalizedCwd = options.cwd ?? options.projectRoot ?? process.cwd();
  const resolvedOptions: AgentContextExtrasOptions = {
    ...options,
    cwd: normalizedCwd,
  };
  const memoryEnv = trimEnv(env[AGENT_MEMORY_FILE_ENV]);
  const requestedMemory = memoryEnv ?? defaultMemoryPath(options.projectRoot, normalizedCwd);
  const requestedSkills = parseRequestedSkills(env[AGENT_PRELOAD_SKILLS_ENV]);
  const enabled = isTruthyEnvFlag(env[AGENT_CONTEXT_EXTRAS_ENV]);
  if (!enabled) return { enabled: false, diagnostics: [], skills: [] };

  const io = createFileIo(resolvedOptions);
  const diagnostics: string[] = [];
  const memory = resolveMemoryBlock(requestedMemory, resolvedOptions, io, diagnostics);
  const skills = resolveSkillBlocks(requestedSkills, resolvedOptions, io, diagnostics);
  return {
    enabled: true,
    diagnostics,
    ...(memory === undefined ? {} : { memory }),
    skills,
  };
}

export function formatAgentContextExtras(resolution: AgentContextExtrasResolution): string | undefined {
  if (!resolution.enabled) return undefined;
  const sections: string[] = [];
  if (resolution.diagnostics.length > 0) sections.push(formatDiagnosticsSection(resolution.diagnostics));
  if (resolution.memory !== undefined) sections.push(formatMemoryBlock(resolution.memory));
  for (const skill of resolution.skills) sections.push(formatSkillBlock(skill));
  if (sections.length === 0) return undefined;
  return clampUtf8Text(
    ["# Context extras", ...sections].join("\n\n"),
    MAX_TOTAL_EXTRAS_BYTES,
    "...[context extras truncated]",
  );
}

export function buildAgentContextExtrasText(options: AgentContextExtrasOptions): {
  text: string | undefined;
  diagnostics: string[];
  enabled: boolean;
} {
  const resolution = resolveAgentContextExtras(options);
  return {
    text: formatAgentContextExtras(resolution),
    diagnostics: resolution.diagnostics,
    enabled: resolution.enabled,
  };
}

function resolveMemoryBlock(
  requestedMemory: string | undefined,
  options: AgentContextExtrasOptions,
  io: FileIo,
  diagnostics: string[],
): AgentContextTextBlock | undefined {
  if (requestedMemory === undefined) return undefined;
  const candidates = resolveExplicitCandidates(requestedMemory, options);
  const resolved = firstExistingFile(candidates, io.exists);
  if (resolved === undefined) {
    diagnostics.push(`Missing memory file: ${firstCandidate(candidates) ?? requestedMemory}`);
    diagnostics.push(`Requested: ${requestedMemory}`);
    return undefined;
  }
  const raw = readFileSafely(io.readFile, resolved);
  if (raw === undefined) {
    diagnostics.push(`Missing memory file: ${resolved}`);
    diagnostics.push(`Requested: ${requestedMemory}`);
    return undefined;
  }
  const clipped = clampBoundedContent(raw, MAX_MEMORY_LINES, MAX_MEMORY_BYTES);
  return {
    kind: "memory",
    requested: requestedMemory,
    source: resolved,
    content: clipped.content,
    truncated: clipped.truncated,
  };
}

function resolveSkillBlocks(
  requestedSkills: string[],
  options: AgentContextExtrasOptions,
  io: FileIo,
  diagnostics: string[],
): AgentContextTextBlock[] {
  const blocks: AgentContextTextBlock[] = [];
  const seen = new Set<string>();
  for (const requested of requestedSkills) {
    const candidates = resolveSkillCandidates(requested, options);
    const resolved = firstExistingFile(candidates, io.exists);
    if (resolved === undefined) {
      diagnostics.push(`Requested: ${requested}`);
      diagnostics.push(formatMissingSkillDiagnostic(candidates));
      diagnostics.push("(skill content unavailable)");
      continue;
    }
    const normalized = path.normalize(resolved);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const raw = readFileSafely(io.readFile, resolved);
    if (raw === undefined) {
      diagnostics.push(`Requested: ${requested}`);
      diagnostics.push(formatMissingSkillDiagnostic(candidates));
      diagnostics.push("(skill content unavailable)");
      continue;
    }
    const clipped = clampBoundedContent(raw, MAX_SKILL_LINES, MAX_SKILL_BYTES);
    blocks.push({
      kind: "skill",
      requested,
      source: resolved,
      content: clipped.content,
      truncated: clipped.truncated,
    });
  }
  return blocks;
}

function formatDiagnosticsSection(messages: string[]): string {
  return messages
    .flatMap((message) => message.split(/\r?\n/).map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`)))
    .join("\n");
}

function formatMemoryBlock(block: AgentContextTextBlock): string {
  const lines = ["## Memory", `Requested: ${block.requested}`, `Source: ${block.source}`, "", block.content];
  if (block.truncated) lines.push("First 200 lines kept.");
  return lines.join("\n");
}

function formatSkillBlock(block: AgentContextTextBlock): string {
  const lines = [
    `## Skill: ${displaySkillName(block.requested, block.source)}`,
    `Requested: ${block.requested}`,
    `Source: ${block.source}`,
    "",
    block.content,
  ];
  if (block.truncated) lines.push("First 200 lines kept.");
  return lines.join("\n");
}

function formatMissingSkillDiagnostic(candidates: string[]): string {
  if (candidates.length === 0) return "Skill source missing. Tried:";
  return [`Skill source missing. Tried:`, ...candidates.map((candidate) => `- ${candidate}`)].join("\n");
}

function displaySkillName(requested: string, source: string): string {
  if (!looksLikePathSpec(requested)) return requested;
  const base = path.basename(source);
  if (base.toUpperCase() === "SKILL.MD") return path.basename(path.dirname(source));
  return path.basename(base, path.extname(base)) || base;
}

function resolveSkillCandidates(spec: string, options: AgentContextExtrasOptions): string[] {
  const requested = spec.trim();
  if (requested === "") return [];
  if (looksLikePathSpec(requested)) return resolveExplicitCandidates(requested, options);
  const bases = uniquePaths([options.cwd, options.projectRoot]);
  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(path.join(base, ".agents", "skills", requested, "SKILL.md"));
    candidates.push(path.join(base, ".pi", "skills", requested, "SKILL.md"));
  }
  return uniquePaths(candidates);
}

function resolveExplicitCandidates(spec: string, options: AgentContextExtrasOptions): string[] {
  const requested = expandHome(spec.trim());
  if (requested === "") return [];
  if (path.isAbsolute(requested)) return [requested];
  return uniquePaths([
    options.cwd === undefined ? undefined : path.resolve(options.cwd, requested),
    options.projectRoot === undefined ? undefined : path.resolve(options.projectRoot, requested),
  ]);
}

function firstExistingFile(candidates: string[], exists: (filePath: string) => boolean): string | undefined {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function firstCandidate(candidates: string[]): string | undefined {
  return candidates[0];
}

interface FileIo {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
}

function createFileIo(options: AgentContextExtrasOptions): FileIo {
  return {
    readFile: options.readFile ?? ((filePath) => readFileSync(filePath, "utf8")),
    exists: options.exists ?? defaultExists,
  };
}

function readFileSafely(readFile: (filePath: string) => string, filePath: string): string | undefined {
  try {
    return readFile(filePath);
  } catch {
    return undefined;
  }
}

function defaultExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function clampBoundedContent(
  text: string,
  maxLines: number,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const lineLimited = lines.slice(0, maxLines).join("\n");
  const truncated = lines.length > maxLines || Buffer.byteLength(lineLimited, "utf8") > maxBytes;
  if (!truncated) return { content: lineLimited, truncated: false };
  const suffix = "...[truncated]";
  const clipped = clampUtf8Text(lineLimited, maxBytes, suffix);
  return { content: clipped, truncated: true };
}

function clampUtf8Text(text: string, maxBytes: number, suffix: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > targetBytes) end = Math.floor(end * 0.9);
  while (end < text.length && Buffer.byteLength(text.slice(0, end + 1), "utf8") <= targetBytes) end += 1;
  return `${text.slice(0, end)}${suffix}`;
}

function parseRequestedSkills(value: string | undefined): string[] {
  const trimmed = trimEnv(value);
  if (trimmed === undefined) return [];
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function trimEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  return value !== undefined && value.trim() === "1";
}

function looksLikePathSpec(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    value.startsWith("~") ||
    path.extname(value) !== ""
  );
}

function expandHome(value: string): string {
  if (!value.startsWith("~")) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of paths) {
    if (item === undefined) continue;
    const normalized = path.normalize(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(item);
  }
  return unique;
}

function defaultMemoryPath(projectRoot: string | undefined, fallbackCwd: string): string {
  const base = projectRoot ?? fallbackCwd;
  return path.join(base, "MEMORY.md");
}
