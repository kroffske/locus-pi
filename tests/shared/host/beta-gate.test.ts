import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BETA_CONFIG_DIRNAME,
  BETA_CONFIG_FILENAME,
  BETA_ENV_VAR,
  betaConfigPath,
  betaEnabled,
} from "../../../extensions/_shared/host/beta-gate.js";

/** The registry the gate dedupes its warnings in, named here exactly as the gate names it. */
const WARNED_CONFIGS = Symbol.for("locus-pi.beta-config-warnings.v1");

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A project directory, optionally carrying `.locus-pi/config.json` with exactly `contents`.
 *
 * Every case gets a FRESH temp directory, which is also what keeps the warning cases
 * independent: the gate suppresses a repeated warning per config path for the life of the
 * process, so two cases sharing one path would silence the second one.
 */
function projectRoot(contents?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-pi-beta-gate-"));
  temporaryRoots.push(root);
  if (contents !== undefined) {
    mkdirSync(path.join(root, BETA_CONFIG_DIRNAME), { recursive: true });
    writeFileSync(path.join(root, BETA_CONFIG_DIRNAME, BETA_CONFIG_FILENAME), contents);
  }
  return root;
}

/**
 * Run `body` with `process.stderr.write` captured. The gate writes to the real stream, so
 * this is the only way to assert on it; the original is restored even when `body` throws.
 */
function capturedStderr(body: () => void): string[] {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

/** No source enables anything unless a case says so; the real process env is never touched. */
function enabled(id: string, options: { env?: string; cwd?: string } = {}): boolean {
  return betaEnabled(id, {
    env: options.env === undefined ? {} : { [BETA_ENV_VAR]: options.env },
    cwd: options.cwd ?? projectRoot(),
  });
}

type BetaGateModule = typeof import("../../../extensions/_shared/host/beta-gate.js");

/**
 * `count` separately evaluated instances of the gate module, standing in for the copies Pi
 * hands the beta entrypoints when it loads them with the module cache disabled. Clearing
 * Vitest's module registry before each import is what forces a fresh evaluation; the caller
 * asserts on the identity of what comes back rather than taking that on trust.
 */
async function loadIndependentGateCopies(count: number): Promise<BetaGateModule[]> {
  const copies: BetaGateModule[] = [];
  for (let index = 0; index < count; index += 1) {
    vi.resetModules();
    copies.push(await import("../../../extensions/_shared/host/beta-gate.js"));
  }
  return copies;
}

describe("beta gate", () => {
  it("enables exactly the ids the environment variable lists", () => {
    expect(enabled("loop", { env: "loop,plan" })).toBe(true);
    expect(enabled("plan", { env: "loop,plan" })).toBe(true);
    expect(enabled("todo-context", { env: "loop,plan" })).toBe(false);
  });

  it("treats a missing or blank environment variable as no opt-in", () => {
    expect(enabled("loop")).toBe(false);
    expect(enabled("loop", { env: "" })).toBe(false);
    expect(enabled("loop", { env: " , ," })).toBe(false);
  });

  it("ignores surrounding whitespace and empty list entries", () => {
    expect(enabled("plan", { env: "  loop , , plan ,  " })).toBe(true);
  });

  it("enables every beta extension for the two wildcards", () => {
    for (const wildcard of ["all", "*"]) {
      expect(enabled("loop", { env: wildcard }), wildcard).toBe(true);
      expect(enabled("todo-context", { env: wildcard }), wildcard).toBe(true);
    }
  });

  it("enables the ids the project config lists", () => {
    const cwd = projectRoot(JSON.stringify({ beta: ["loop"] }));
    expect(enabled("loop", { cwd })).toBe(true);
    expect(enabled("plan", { cwd })).toBe(false);
  });

  /**
   * Editors on Windows routinely save JSON with a byte order mark. The file below is the
   * config the operator wrote and sees; only an invisible encoding marker separates it from
   * the case above, and that must not read as a syntax error.
   */
  it("reads a config saved with a UTF-8 byte order mark", () => {
    const cwd = projectRoot(`\uFEFF${JSON.stringify({ beta: ["loop"] })}`);
    const written = capturedStderr(() => {
      expect(enabled("loop", { cwd })).toBe(true);
    });
    expect(written).toEqual([]);
  });

  it("honours the wildcard and whitespace rules in the project config too", () => {
    expect(enabled("plan", { cwd: projectRoot(JSON.stringify({ beta: [" plan "] })) })).toBe(true);
    expect(enabled("plan", { cwd: projectRoot(JSON.stringify({ beta: ["all"] })) })).toBe(true);
  });

  it("enables an id named by either source alone", () => {
    const cwd = projectRoot(JSON.stringify({ beta: ["loop"] }));
    expect(enabled("plan", { cwd, env: "plan" })).toBe(true);
    expect(enabled("loop", { cwd, env: "plan" })).toBe(true);
    expect(enabled("todo-context", { cwd, env: "plan" })).toBe(false);
  });

  it("stays disabled and silent when the project has no config file", () => {
    const written = capturedStderr(() => {
      expect(enabled("loop")).toBe(false);
    });
    expect(written).toEqual([]);
  });

  /** A config that configures other things is valid and complete; it simply enables nothing. */
  it("stays disabled and silent when the config declares no beta list", () => {
    const cwd = projectRoot(JSON.stringify({ somethingElse: true }));
    const written = capturedStderr(() => {
      expect(enabled("loop", { cwd })).toBe(false);
    });
    expect(written).toEqual([]);
  });

  it("fails closed with one warning on a config that is not valid JSON", () => {
    const cwd = projectRoot("{ not json");
    const written = capturedStderr(() => {
      expect(enabled("loop", { cwd })).toBe(false);
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`locus-pi: ${betaConfigPath(cwd)} ignored: is not valid JSON`);
    expect(written[0]?.endsWith("\n")).toBe(true);
  });

  it("fails closed with one warning on a config that is not a JSON object", () => {
    const cwd = projectRoot(JSON.stringify(["loop"]));
    const written = capturedStderr(() => {
      expect(enabled("loop", { cwd })).toBe(false);
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("must contain a JSON object");
  });

  it("fails closed with one warning when beta is not an array of ids", () => {
    for (const beta of ["loop", { loop: true }, ["loop", 7]]) {
      const cwd = projectRoot(JSON.stringify({ beta }));
      const written = capturedStderr(() => {
        expect(enabled("loop", { cwd }), JSON.stringify(beta)).toBe(false);
      });
      expect(written, JSON.stringify(beta)).toHaveLength(1);
      expect(written[0]).toContain('"beta" must be an array of extension ids');
    }
  });

  /**
   * The three beta entrypoints each ask the gate on load, so a malformed config would
   * otherwise greet the operator with the same line three times.
   */
  it("warns once per config path no matter how many extensions ask", () => {
    const cwd = projectRoot("{ not json");
    const written = capturedStderr(() => {
      expect(enabled("loop", { cwd })).toBe(false);
      expect(enabled("plan", { cwd })).toBe(false);
      expect(enabled("todo-context", { cwd })).toBe(false);
    });
    expect(written).toHaveLength(1);
  });

  /**
   * The cross-copy proof the case above cannot give.
   *
   * That case calls ONE instance of the gate three times, and a plain module-level `Set`
   * would pass it just as well — the dedup it demonstrates is per-instance. Pi loads every
   * registered entrypoint with the module cache disabled, so the three beta entrypoints each
   * hold their own copy of `beta-gate.ts`, and the versioned `globalThis` slot the gate
   * actually uses exists for exactly that case. `check:layers` rule 7 does not see the
   * difference either: it asserts STATICALLY that one module names the symbol, and stays
   * green for an edit that keeps the `Symbol.for` line and dedupes in a module binding.
   *
   * So this case drives one malformed config path across three independently evaluated
   * copies. With the registry the operator gets one line; with per-copy state, three.
   */
  it("warns once across independently loaded copies of the gate module", async () => {
    const copies = await loadIndependentGateCopies(3);
    // Without this the case would pass on a single shared instance, proving nothing.
    expect(new Set(copies.map((copy) => copy.betaEnabled)).size).toBe(3);

    const cwd = projectRoot("{ not json");
    const written = capturedStderr(() => {
      for (const [index, copy] of copies.entries()) {
        expect(copy.betaEnabled(`beta-${index}`, { env: {}, cwd })).toBe(false);
      }
    });
    expect(written).toHaveLength(1);
  });

  /**
   * `warnOnce` reads a process-global slot that today has one declared owner, so nothing
   * puts a foreign value there — but a throw from the gate leaves through `betaEnabled` and
   * lands inside Pi's extension loader, failing the whole session over a typo in a config
   * file. The gate has to claim an occupied slot rather than trust what it finds.
   */
  it("survives a warning registry slot occupied by something that is not a Set", () => {
    const host = globalThis as unknown as Record<symbol, unknown>;
    const occupant = host[WARNED_CONFIGS];
    try {
      host[WARNED_CONFIGS] = { hijacked: true };
      const cwd = projectRoot("{ not json");
      const written = capturedStderr(() => {
        expect(enabled("loop", { cwd })).toBe(false);
      });
      expect(written).toHaveLength(1);
    } finally {
      host[WARNED_CONFIGS] = occupant;
    }
  });

  /** An environment opt-in must not be lost to a broken file, and the file is still reported. */
  it("still honours the environment variable when the config is unusable", () => {
    const cwd = projectRoot("{ not json");
    const written = capturedStderr(() => {
      expect(enabled("loop", { cwd, env: "loop" })).toBe(true);
    });
    expect(written).toHaveLength(1);
  });
});
