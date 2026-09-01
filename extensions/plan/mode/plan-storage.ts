import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path, { basename, dirname } from "node:path";

interface PlanFileSnapshot {
  path: string;
  bytes: Buffer;
}

export interface PreparedPlanLibrary {
  directory: string;
  migrated: number;
}

/** Lowercase filesystem slug with a stable non-empty fallback. */
export function slugify(value: string): string {
  const result = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || "plan";
}

/** Collision-resistant saved-plan name derived from the request's first line. */
export function planSlug(request: string, now = new Date()): string {
  const body = slugify(request.split(/\r?\n/)[0] ?? "")
    .slice(0, 48)
    .replace(/-+$/, "");
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = now.getTime().toString(36).slice(-4);
  return `${body}-${date}-${suffix}`;
}

/**
 * Normalizes a git remote URL to one stable host/path key.
 * SSH and HTTPS forms of the same remote intentionally collapse together.
 */
export function normalizeRemote(url: string): string {
  let normalized = url.trim();
  const sshShort = /^[^/@]+@([^:]+):(.+)$/.exec(normalized);
  if (sshShort) {
    normalized = `${sshShort[1]}/${sshShort[2]}`;
  } else {
    normalized = normalized.replace(/^(?:https?|ssh|git):\/\//, "");
    normalized = normalized.replace(/^[^@/]*@/, "");
    normalized = normalized.replace(/^[^:@/]+:[^/@]+@/, "");
  }
  return normalized
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** The canonical origin key, or undefined when the checkout has no origin. */
export function canonicalGitRemote(projectRoot: string): string | undefined {
  try {
    const remote = execFileSync("git", ["-C", projectRoot, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return remote === "" ? undefined : normalizeRemote(remote);
  } catch {
    return undefined;
  }
}

/** Stable legacy project key used only to find the former home-level library. */
export function projectSlug(projectRoot: string): string {
  const key = canonicalGitRemote(projectRoot) ?? realpathSync(projectRoot);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${slugify(basename(key))}-${hash}`;
}

/** Home root override retained only for locating legacy plan input in tests and migrations. */
export function piHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["LOCUS_PI_HOME"] ?? homedir();
}

/** The project-local authority for saved `/plan` documents. */
export function planLibraryDir(projectRoot: string): string {
  return path.join(projectRoot, ".locus-pi", "plans");
}

/** The former home-level library. It is migration input and never a write target. */
export function legacyPlanLibraryDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(piHome(env), ".pi", "locus-pi", projectSlug(projectRoot), "plans");
}

/** Absolute path for one saved plan in the project-local authority. */
export function planArtifactPath(projectRoot: string, slug: string): string {
  return path.join(planLibraryDir(projectRoot), `${slug}.md`);
}

/** Lists only project-local plans. Call `preparePlanLibrary` before operator use. */
export function listPlanSlugs(projectRoot: string): string[] {
  return [...scanPlanFiles(planLibraryDir(projectRoot), "current", projectRoot).keys()]
    .map((fileName) => basename(fileName, ".md"))
    .sort()
    .reverse();
}

/**
 * Prepares the project-local plan library without overwriting or deleting legacy data.
 *
 * The complete current and legacy sets are read before any write. Different overlaps
 * and unsafe Markdown entries therefore fail before migration starts. Legacy-only
 * files are created atomically and byte-read back. A retry accepts the identical
 * prefix left by an interrupted earlier attempt and continues with the remainder.
 */
export function preparePlanLibrary(projectRoot: string, env: NodeJS.ProcessEnv = process.env): PreparedPlanLibrary {
  const currentDirectory = planLibraryDir(projectRoot);
  const legacyDirectory = legacyPlanLibraryDir(projectRoot, env);
  const current = scanPlanFiles(currentDirectory, "current", projectRoot);
  const legacy = scanPlanFiles(legacyDirectory, "legacy", piHome(env));

  const conflicts: string[] = [];
  const missing: Array<[string, PlanFileSnapshot]> = [];
  for (const [fileName, legacyFile] of legacy) {
    const currentFile = current.get(fileName);
    if (currentFile === undefined) {
      missing.push([fileName, legacyFile]);
      continue;
    }
    if (!currentFile.bytes.equals(legacyFile.bytes)) conflicts.push(fileName);
  }

  if (conflicts.length > 0) {
    throw new Error(
      [
        `Saved-plan migration blocked: current and legacy files differ: ${conflicts.join(", ")}.`,
        `Current library: ${currentDirectory}`,
        `Legacy library: ${legacyDirectory}`,
        "No files were changed. Reconcile the named files manually, then retry.",
      ].join(" "),
    );
  }

  let migrated = 0;
  for (const [fileName, legacyFile] of missing) {
    assertPlanLibraryPathChain(projectRoot, currentDirectory, "current");
    mkdirSync(currentDirectory, { recursive: true });
    assertPlanLibraryPathChain(projectRoot, currentDirectory, "current");
    copyPlanAtomically(legacyFile, path.join(currentDirectory, fileName), projectRoot);
    migrated += 1;
  }

  const prepared = scanPlanFiles(currentDirectory, "current", projectRoot);
  for (const [fileName, legacyFile] of legacy) {
    const currentFile = prepared.get(fileName);
    if (currentFile === undefined || !currentFile.bytes.equals(legacyFile.bytes)) {
      throw new Error(
        `Saved-plan migration could not prove ${fileName} in ${currentDirectory}. ` +
          `The legacy source remains unchanged at ${legacyFile.path}; retry after repairing the current library.`,
      );
    }
  }

  return { directory: currentDirectory, migrated };
}

/** Rebind one prepared legacy plan to its byte-proven project-local copy. */
export function rebindPreparedPlanArtifactPath(
  projectRoot: string,
  artifactPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const legacyDirectory = legacyPlanLibraryDir(projectRoot, env);
  const resolvedArtifact = path.resolve(artifactPath);
  if (dirname(resolvedArtifact) !== path.resolve(legacyDirectory)) return artifactPath;

  const currentDirectory = planLibraryDir(projectRoot);
  assertPlanLibraryPathChain(piHome(env), legacyDirectory, "legacy");
  assertPlanLibraryPathChain(projectRoot, currentDirectory, "current");
  const currentPath = path.join(currentDirectory, basename(resolvedArtifact));
  const legacyBytes = readRegularFileIfPresent(resolvedArtifact);
  const currentBytes = readRegularFileIfPresent(currentPath);
  if (legacyBytes === undefined || currentBytes === undefined || !currentBytes.equals(legacyBytes)) {
    throw new Error(
      `Saved-plan migration could not prove the active plan at ${currentPath}. ` +
        `The legacy source remains unchanged at ${resolvedArtifact}; retry after repairing the current library.`,
    );
  }
  return currentPath;
}

function scanPlanFiles(
  directory: string,
  kind: "current" | "legacy",
  authorityRoot: string,
): Map<string, PlanFileSnapshot> {
  assertPlanLibraryPathChain(authorityRoot, directory, kind);
  let entries: string[];
  try {
    entries = readdirSync(directory)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return new Map();
    throw new Error(`Cannot read ${kind} saved-plan library ${directory}: ${errorMessage(error)}`);
  }

  const files = new Map<string, PlanFileSnapshot>();
  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch (error) {
      throw new Error(`Cannot inspect ${kind} saved plan ${filePath}: ${errorMessage(error)}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `Saved-plan migration blocked: ${kind} Markdown entry must be a regular file, not a symlink or directory: ${filePath}. No files were changed.`,
      );
    }
    try {
      files.set(entry, { path: filePath, bytes: readFileSync(filePath) });
    } catch (error) {
      throw new Error(`Cannot read ${kind} saved plan ${filePath}: ${errorMessage(error)}`);
    }
  }
  return files;
}

function copyPlanAtomically(source: PlanFileSnapshot, destination: string, authorityRoot: string): void {
  assertPlanLibraryPathChain(authorityRoot, dirname(destination), "current");
  const temporary = path.join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    writeFileSync(temporary, source.bytes, { flag: "wx" });
    temporaryCreated = true;
    if (!readFileSync(temporary).equals(source.bytes)) {
      throw new Error(`temporary byte readback differed for ${temporary}`);
    }

    try {
      linkSync(temporary, destination);
    } catch (error) {
      const concurrent = readRegularFileIfPresent(destination);
      if (concurrent === undefined || !concurrent.equals(source.bytes)) throw error;
    }

    if (!readFileSync(destination).equals(source.bytes)) {
      throw new Error(`destination byte readback differed for ${destination}`);
    }
    assertPlanLibraryPathChain(authorityRoot, dirname(destination), "current");
  } catch (error) {
    throw new Error(
      `Cannot migrate saved plan ${source.path} to ${destination}: ${errorMessage(error)}. ` +
        "The legacy source was not changed; repair the current library and retry.",
    );
  } finally {
    if (temporaryCreated) {
      try {
        unlinkSync(temporary);
      } catch {
        // A leftover private temp file is safer than deleting an unproven destination.
      }
    }
  }
}

/** Reject every symlink or non-directory below the owned project/home boundary. */
function assertPlanLibraryPathChain(authorityRoot: string, directory: string, kind: "current" | "legacy"): void {
  const root = path.resolve(authorityRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Saved-plan ${kind} library escapes its authority root: ${directory}. No files were changed.`);
  }

  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Saved-plan migration blocked: ${kind} library path component must not be a symlink: ${current}. No files were changed.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `Saved-plan migration blocked: ${kind} library path component must be a directory: ${current}. No files were changed.`,
      );
    }
  }
}

function readRegularFileIfPresent(filePath: string): Buffer | undefined {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return readFileSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
