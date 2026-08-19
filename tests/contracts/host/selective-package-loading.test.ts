import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, type PackageSource, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

interface ExtensionManifest {
  provides: { tools: string[]; commands: string[]; hooks: string[] };
}

const packageRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  pi: { extensions: string[]; skills: string[] };
};
const extensionIds = packageJson.pi.extensions.map((entrypoint) => {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/u.exec(entrypoint);
  if (!match?.[1]) throw new Error(`Invalid package extension entrypoint: ${entrypoint}`);
  return match[1];
});
const bundledSkillNames = uniqueSorted(
  packageJson.pi.skills.flatMap((skillsRoot) => {
    const directory = path.resolve(packageRoot, skillsRoot);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(directory, entry.name, "SKILL.md")))
      .map((entry) => entry.name);
  }),
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe(`selective package loading through installed Pi ${VERSION}`, () => {
  it.each([
    ["full", extensionIds],
    ["workflows-only", ["workflows"]],
    ["agents-only", ["agents"]],
    ["loop-only", ["loop"]],
    ["status-line-only", ["status-line"]],
  ] as const)("loads only the requested entrypoints for %s", async (_profile, selectedIds) => {
    const result = await loadProfile([...selectedIds], false);
    expect(result.extensionIds).toEqual([...selectedIds].sort());
    expect(result.tools).toEqual(expectedSurfaces([...selectedIds], "tools"));
    expect(result.commands).toEqual(expectedSurfaces([...selectedIds], "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces([...selectedIds], "hooks"));
    expect(result.packageSkills).toEqual([]);
  });

  it("keeps bundled skills available when the package filter omits the skills key", async () => {
    const result = await loadProfile(["workflows"], true);
    expect(result.extensionIds).toEqual(["workflows"]);
    expect(result.packageSkills).toEqual(bundledSkillNames);
  });
  // Every case reloads the real Pi host off disk. That is fast in isolation and
  // slow whenever the machine is already busy, so the suite states its own
  // budget instead of inheriting the 5s default.
}, 30_000);

async function loadProfile(selectedIds: string[], includeSkills: boolean) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-host-contract-"));
  temporaryRoots.push(temporaryRoot);
  const agentDir = path.join(temporaryRoot, "agent");
  const cwd = path.join(temporaryRoot, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const source: PackageSource = {
    source: packageRoot,
    extensions: selectedIds.map((id) => `extensions/${id}/index.ts`),
    ...(includeSkills ? {} : { skills: [] }),
  };
  const settingsManager = SettingsManager.inMemory({ packages: [source] });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors, `Pi ${VERSION} extension load errors`).toEqual([]);

  return {
    extensionIds: loaded.extensions.map((extension) => path.basename(path.dirname(extension.path))).sort(),
    tools: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])),
    commands: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.commands.keys()])),
    hooks: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.handlers.keys()])),
    packageSkills: uniqueSorted(
      loader
        .getSkills()
        .skills.filter((skill) => skill.sourceInfo.origin === "package" && skill.sourceInfo.source === packageRoot)
        .map((skill) => skill.name),
    ),
  };
}

function expectedSurfaces(selectedIds: string[], key: "tools" | "commands" | "hooks", topLevel = false): string[] {
  const values = selectedIds.flatMap((id) => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "extensions", id, "manifest.json"), "utf8"),
    ) as ExtensionManifest;
    return manifest.provides[key];
  });
  return uniqueSorted(topLevel ? values.map((value) => value.trim().split(/\s+/u)[0]!).filter(Boolean) : values);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
