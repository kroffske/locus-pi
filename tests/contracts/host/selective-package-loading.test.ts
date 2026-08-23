import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, type PackageSource, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { BETA_CONFIG_DIRNAME, BETA_CONFIG_FILENAME, BETA_ENV_VAR } from "../../../extensions/_shared/host/beta-gate.js";
import { operateWorkflowSkillHosts } from "../../../extensions/workflows/command/skills.js";
import { readExtensionManifest } from "../helpers/package-contract.js";

const packageRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  pi: { extensions: string[]; skills: string[] };
};
const extensionIds = packageJson.pi.extensions.map((entrypoint) => {
  const match = /^\.\/extensions\/([^/]+)\/index\.ts$/u.exec(entrypoint);
  if (!match?.[1]) throw new Error(`Invalid package extension entrypoint: ${entrypoint}`);
  return match[1];
});
/** The two tiers, read from the manifests so a tier change needs no edit here. */
const defaultTierIds = extensionIds.filter((id) => readExtensionManifest(id, packageRoot).tier === "default");
const betaTierIds = extensionIds.filter((id) => readExtensionManifest(id, packageRoot).tier === "beta");
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
    ["workflows-only", ["workflows"]],
    ["agents-only", ["agents"]],
    ["status-line-only", ["status-line"]],
  ] as const)("loads only the requested entrypoints for %s", async (_profile, selectedIds) => {
    const result = await loadProfile([...selectedIds]);
    expect(result.extensionIds).toEqual([...selectedIds].sort());
    expect(result.tools).toEqual(expectedSurfaces([...selectedIds], "tools"));
    expect(result.commands).toEqual(expectedSurfaces([...selectedIds], "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces([...selectedIds], "hooks"));
    expect(result.packageSkills).toEqual([]);
  });

  it("loads every declared surface when every entrypoint is selected and beta is enabled", async () => {
    const result = await loadProfile(extensionIds, { beta: "all" });
    expect(result.extensionIds).toEqual([...extensionIds].sort());
    expect(result.tools).toEqual(expectedSurfaces(extensionIds, "tools"));
    expect(result.commands).toEqual(expectedSurfaces(extensionIds, "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces(extensionIds, "hooks"));
  });

  /**
   * The beta tier, proven where it has to be true: against the host's own loader rather than a
   * direct call to the entrypoint. Every entrypoint still loads and Pi still lists it — the
   * package makes no claim it cannot keep about what Pi reports — and what a fresh installation
   * receives is exactly the default tier's tools, commands and hooks.
   */
  it("loads every entrypoint but registers only default-tier surfaces with no beta opt-in", async () => {
    const result = await loadProfile(extensionIds);
    expect(betaTierIds.length, "no beta extension left to prove the gate with").toBeGreaterThan(0);
    expect(result.extensionIds).toEqual([...extensionIds].sort());
    expect(result.tools).toEqual(expectedSurfaces(defaultTierIds, "tools"));
    expect(result.commands).toEqual(expectedSurfaces(defaultTierIds, "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces(defaultTierIds, "hooks"));
  });

  it("loads a selected beta entrypoint with no surfaces at all until it is enabled", async () => {
    const result = await loadProfile(["loop"]);
    expect(result.extensionIds).toEqual(["loop"]);
    expect(result.tools).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.hooks).toEqual([]);
  });

  it.each([
    ["the environment variable", { beta: "loop" }],
    ["the project config file", { betaConfig: JSON.stringify({ beta: ["loop"] }) }],
  ] as const)("registers the whole beta surface when %s enables it", async (_source, options) => {
    const result = await loadProfile(["loop"], options);
    expect(result.extensionIds).toEqual(["loop"]);
    expect(result.tools).toEqual(expectedSurfaces(["loop"], "tools"));
    expect(result.commands).toEqual(expectedSurfaces(["loop"], "commands", true));
    expect(result.hooks).toEqual(expectedSurfaces(["loop"], "hooks"));
  });

  it("keeps bundled skills available when the package filter omits the skills key", async () => {
    const result = await loadProfile(["workflows"], { includeSkills: true });
    expect(result.extensionIds).toEqual(["workflows"]);
    expect(result.packageSkills).toEqual(bundledSkillNames);
  });

  it("deduplicates Codex project links to the exact packaged skill trees without a collision", async () => {
    const result = await loadProfile(["workflows"], { includeSkills: true, syncProjectSkills: true });
    expect(result.workflowSkillNames).toEqual(bundledSkillNames);
    expect(result.workflowSkillDiagnostics).toEqual([]);
  });
  // Every case reloads the real Pi host off disk. That is fast in isolation and
  // slow whenever the machine is already busy, so the suite states its own
  // budget instead of inheriting the 5s default.
}, 30_000);

interface ProfileOptions {
  /** Leave the package filter's `skills` key out, so Pi resolves the bundled skill trees. */
  includeSkills?: boolean;
  syncProjectSkills?: boolean;
  /** `LOCUS_PI_BETA` for the duration of the load. Unset when omitted. */
  beta?: string;
  /** Written to `<cwd>/.locus-pi/config.json` before the load, as a project would. */
  betaConfig?: string;
}

async function loadProfile(selectedIds: string[], options: ProfileOptions = {}) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-host-contract-"));
  temporaryRoots.push(temporaryRoot);
  const agentDir = path.join(temporaryRoot, "agent");
  const cwd = path.join(temporaryRoot, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (options.betaConfig !== undefined) {
    mkdirSync(path.join(cwd, BETA_CONFIG_DIRNAME), { recursive: true });
    writeFileSync(path.join(cwd, BETA_CONFIG_DIRNAME, BETA_CONFIG_FILENAME), options.betaConfig);
  }
  if (options.syncProjectSkills) {
    operateWorkflowSkillHosts({
      action: "sync",
      host: "codex",
      scope: "project",
      projectRoot: cwd,
      packageRoot,
      userHome: temporaryRoot,
    });
  }

  const source: PackageSource = {
    source: packageRoot,
    extensions: selectedIds.map((id) => `extensions/${id}/index.ts`),
    ...(options.includeSkills ? {} : { skills: [] }),
  };
  const settingsManager = SettingsManager.inMemory({ packages: [source] });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

  const loaded = await inIsolatedProcessState(temporaryRoot, cwd, options.beta, async () => {
    await loader.reload(options.syncProjectSkills ? { resolveProjectTrust: async () => true } : undefined);
    return loader.getExtensions();
  });
  const loadedSkills = loader.getSkills();
  expect(loaded.errors, `Pi ${VERSION} extension load errors`).toEqual([]);

  return {
    extensionIds: loaded.extensions.map((extension) => path.basename(path.dirname(extension.path))).sort(),
    tools: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])),
    commands: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.commands.keys()])),
    hooks: uniqueSorted(loaded.extensions.flatMap((extension) => [...extension.handlers.keys()])),
    packageSkills: uniqueSorted(
      loadedSkills.skills
        .filter((skill) => skill.sourceInfo.origin === "package" && skill.sourceInfo.source === packageRoot)
        .map((skill) => skill.name),
    ),
    workflowSkillNames: loadedSkills.skills
      .map((skill) => skill.name)
      .filter((name) => bundledSkillNames.includes(name))
      .sort(),
    workflowSkillDiagnostics: loadedSkills.diagnostics.filter((diagnostic) =>
      bundledSkillNames.some((name) => JSON.stringify(diagnostic).includes(name)),
    ),
  };
}

/**
 * Run one host load with every piece of process state it reads under this test's control, and
 * hand it all back afterwards. `DefaultResourceLoader` takes an explicit `cwd` and `agentDir`,
 * but three inputs still reach past them into the developer's own machine:
 *
 *   HOME / XDG_CONFIG_HOME — Pi discovers user-scope skills and settings from the home
 *     directory. A machine that has this package's own workflow skills installed under
 *     `~/.agents/skills/` shadows and collides with the packaged trees, which fails the two
 *     skill cases for a reason that has nothing to do with the package.
 *   LOCUS_PI_BETA and `<process.cwd()>/.locus-pi/config.json` — the beta gate's two sources.
 *     A developer's own beta opt-in, in the environment or in this checkout, would enable
 *     extensions the tier cases assert are silent. The working directory is moved to the
 *     temporary project so the config file the gate reads is the one a case wrote, and Pi is
 *     the only reader of a working directory it was handed explicitly anyway.
 */
async function inIsolatedProcessState<T>(
  home: string,
  cwd: string,
  beta: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const names = ["HOME", "XDG_CONFIG_HOME", BETA_ENV_VAR] as const;
  const previousEnv = names.map((name) => [name, process.env[name]] as const);
  const previousCwd = process.cwd();
  process.env["HOME"] = home;
  process.env["XDG_CONFIG_HOME"] = path.join(home, "config");
  if (beta === undefined) delete process.env[BETA_ENV_VAR];
  else process.env[BETA_ENV_VAR] = beta;
  process.chdir(cwd);
  try {
    return await body();
  } finally {
    process.chdir(previousCwd);
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectedSurfaces(selectedIds: string[], key: "tools" | "commands" | "hooks", topLevel = false): string[] {
  const values = selectedIds.flatMap((id) => readExtensionManifest(id, packageRoot).provides[key]);
  return uniqueSorted(topLevel ? values.map((value) => value.trim().split(/\s+/u)[0]!).filter(Boolean) : values);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
