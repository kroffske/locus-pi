/**
 * check-extension-layers.ts — the scripted ownership guardrail for the
 * `extensions/_shared` breakup (task T-135, work item W1).
 *
 * WHY THIS EXISTS
 *
 * `extensions/_shared` was a flat bag of modules with no declared direction, so
 * nothing stopped a foundational module from importing a feature entrypoint. The
 * refactor that split it ran as a series of independent slices, and between slices the
 * tree was half-migrated by design. A reviewer could not hold "which of 64 files is
 * allowed to import which" in their head across that many pull requests, so the
 * ownership decision is embedded here as data and re-checked mechanically.
 *
 * The relocations have all landed: `_shared` now holds nothing but its six named layer
 * directories, and nothing is awaiting relocation. The ledger stays because it is what
 * keeps the direction enforced from here on — the rules below govern every future edit,
 * not only the slices that established them.
 *
 * THE LEDGER
 *
 * Every `.ts` file under `extensions/_shared/**` is classified exactly once:
 *   - `shared:<layer>`   its final home is a named `_shared` layer;
 *   - `feature:<path>`   its final home is a feature directory, and it is only
 *                        still in `_shared` because its slice has not run yet.
 *
 * RULES ENFORCED
 *
 *   1. No upward import. No file under `extensions/_shared/**` may import
 *      `extensions/**` outside `_shared`. This is the rule the whole refactor
 *      exists to establish; it applies to feature-classified files too.
 *   2. Layer order. A `shared:<layer>` file may import another `_shared` file only
 *      when the target layer's rank is <= its own. Same-layer imports are allowed.
 *      `operator` is narrowed further: it may reach only `host` and itself.
 *   3. Pending-relocation exemption. `feature:*` files still sitting in `_shared`
 *      are exempt from rule 2 (their edges become legal feature-to-shared or
 *      feature-to-feature edges once relocated) but never from rule 1.
 *   4. Destination reached. When a ledger entry's file is gone from `_shared`, its
 *      declared destination file must exist. A slice that deletes a source without
 *      landing it fails here.
 *   5. No unledgered file. A new shared file with no declared owner fails.
 *   6. Subdirectory agreement. A file at `extensions/_shared/<dir>/<name>.ts` must
 *      have `<dir>` equal to its declared layer.
 *   7. Registry inventory. Every `Symbol.for("locus-pi.…")` under `extensions/**`
 *      must match a declared registry by BOTH symbol string and owning module, and
 *      every declared registry must still be found. Matching the path is what makes
 *      a relocation that duplicates a registry into a second module fail.
 *   8. Mutable module state. Declared non-symbol mutable module state must still be
 *      present where declared, and a new undeclared mutable exported container in
 *      `_shared` fails.
 *   9. Feature-internal module. A module declared internal to one feature may be
 *      imported, from another feature directory, only through that feature's
 *      declared facade file. Rule 1 stops a shared module from reaching into a
 *      feature; nothing stopped one feature from reaching into another's internals,
 *      which is how a narrow facade becomes decorative one edit after it lands.
 *
 * SCOPE — READ THIS BEFORE WIDENING IT
 *
 * The rule-7 registry sweep and the rule-9 importer sweep cover `extensions/**`
 * only. Tests are deliberately out of scope for both.
 *
 * For rule 7: `tests/extensions/agents/agent-live-store-entrypoints.test.ts`
 * legitimately holds a historical `locus-pi.agent-live-store.v3` key to prove the
 * superseded slot stays empty, and a sweep that demanded a ledger entry for it
 * would either reject that test or force the ledger to carry dead versions. Tests
 * assert about registries; they do not own them. Only executable sources are
 * parsed (`.ts`, `.mts`, `.mjs`, `.js`) — a `Symbol.for` spelled inside Markdown
 * or JSON under `extensions/**` is prose, not a registry, and the AST walk also
 * means a mention inside a comment does not register.
 *
 * For rule 9: a test of a feature-internal module has to import that module, or it
 * is testing the facade instead and the internals go uncovered. Rule 9 governs what
 * ships — which extension may depend on which — and `extensions/_shared/**` is
 * excluded from it for the same reason: a `_shared` sibling's edges are already
 * fully governed by rules 1, 2 and 3, and a second verdict on them would only
 * disagree.
 *
 * Imports are read from the real TypeScript AST rather than by regular expression:
 * `_shared` modules contain comment prose and regex literals that a line-based
 * matcher misreads as import statements. Static `import`, `export … from`,
 * `import type`, inline `import("…").T` type nodes, and dynamic `import("…")` with
 * a literal specifier are all edges. `import type` is reported distinctly but
 * enforced identically: a type-only edge still encodes ownership.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Ledger: shared layers
// ---------------------------------------------------------------------------

type SharedLayer = "host" | "operator" | "runtime" | "model" | "project" | "agent-runtime";

/**
 * Rank is the only thing rule 2 compares, EXCEPT for `operator`, which is
 * narrowed by name in `layerImportAllowed` in both directions: it may reach only
 * `host` and itself, and no other layer may reach it. Operator UI is a leaf
 * consumer — a shared layer that depended on it would drag command registration
 * and rendering into foundational code.
 */
const LAYER_RANK: Record<SharedLayer, number> = {
  host: 0,
  operator: 1,
  runtime: 2,
  model: 2,
  project: 3,
  "agent-runtime": 4,
};

/**
 * Empty since W7. It held one entry, `mixed`, for the two catch-all files (`types.ts`,
 * `state.ts`) that W7 shredded by domain; both are gone and so is the layer. The
 * machinery stays because the rule-4 branch it drives — retire the entry, do not demand
 * a destination — is the correct handling for any future provisional classification, and
 * because a reviewer reading the ledger should see that the concept exists and is unused.
 */
const PROVISIONAL_LAYERS: readonly SharedLayer[] = [];

const SHARED_LAYER_MEMBERS: Record<SharedLayer, readonly string[]> = {
  host: [
    "pi-api",
    "error-text",
    "files",
    "validation",
    "redaction",
    "render-profile",
    "render-scheduler",
    "safe-output",
    /**
     * `beta-gate` belongs to the lowest layer on purpose: a beta entrypoint calls it as
     * its first statement, before it constructs anything, so it may depend on nothing
     * but `node:` builtins. It duplicates the `.locus-pi` directory name rather than
     * importing `workflows/runtime/workflow-run-layout.ts`, because rule 1 forbids a
     * shared module from reaching into a feature directory.
     */
    "beta-gate",
  ],
  operator: [
    "command-ui",
    "widget-render",
    "operator-ui",
    "operator-status",
    "operator-input",
    "operator-interaction",
    "operator-keys",
    "operator-question",
    "operator-notify",
    "viewer-geometry",
  ],
  /**
   * `runtime-capabilities` was provisionally classified `host` and carried a declared
   * upward edge to `session-core`. W5 resolved it here rather than by splitting: every
   * one of its consumers imports `createSessionStore`, so the store-construction half
   * is the module's whole reason to exist, and `getRuntimeCapabilityReport` reports on
   * that same session store. Nothing in `host` or `operator` imports it, so it owes
   * nothing to a lower rank.
   */
  runtime: ["session-core", "artifacts", "event-bus", "runtime-capabilities"],
  model: ["model-settings", "live-model-display", "workflow-model-resolve"],
  project: ["goal-mode", "prompt-command-store", "tasks-store", "task-bridge", "todo-state"],
  "agent-runtime": [
    "agents",
    "agent-context-extras",
    "agent-evidence-evaluator",
    "agent-execution-prompt",
    "agent-executor-host",
    /**
     * W7 landed the closed failure-cause list here rather than in `agent-runner`, the
     * envelope that carries it and re-exports it. `agent-runner` imports `node:crypto`,
     * and `extensions/workflows/runtime/workflow-runtime.ts` — the host-agnostic
     * workflow core — reads the list as a VALUE, so it must come from a module with no
     * imports at all. This one has none; keep it that way.
     */
    "agent-failure-cause",
    "agent-live-panel",
    "agent-live-transcript",
    "agent-names",
    "agent-read-only-policy",
    "agent-runner",
    "agent-sdk-host",
    "agent-system-prompt",
    "fleet-menu",
  ],
};

// ---------------------------------------------------------------------------
// Ledger: feature destinations (all landed; rule 4 asserts each one still exists)
// ---------------------------------------------------------------------------

const WORKFLOW_RUNTIME_MODULES: readonly string[] = [
  "workflow-agent-bridge",
  "workflow-artifacts",
  "workflow-budget",
  "workflow-discovery",
  "workflow-failure",
  "workflow-handoff",
  "workflow-journal",
  "workflow-replay",
  "workflow-resources",
  "workflow-result",
  "workflow-run-report",
  "workflow-runner",
  "workflow-runtime",
  "workflow-script-identity",
  "workflow-worktree",
];

/**
 * Destination is the module's final file path. `workflow-journal` is listed like
 * every other workflow module: W2 routed its externally consumed READ EXPORTS
 * through `extensions/workflows/run-read.ts`, which is a facade file, not a new
 * home for the module — W3 moved the journal itself to the destination below,
 * alongside the other thirteen `workflow-*` modules of the same subsystem.
 */
const FEATURE_DESTINATIONS: Record<string, string> = {
  ...Object.fromEntries(
    WORKFLOW_RUNTIME_MODULES.map((name) => [name, `extensions/workflows/runtime/${name}.ts`] as const),
  ),
  "loop-continuation": "extensions/loop/loop-continuation.ts",
  "ast-engine": "extensions/ast-structural-edit/ast-engine.ts",
  "human-control": "extensions/ask-user-question/human-control.ts",
  "goal-ai-draft": "extensions/plan/goal-ai-draft.ts",
  "mode-state": "extensions/plan/mode-state.ts",
};

/**
 * The read-only facade W2 landed. Rule 9 requires it unconditionally, since it is the
 * declared way past a feature-internal module; the rule-4 check below is the narrower
 * one that catches the journal leaving `_shared` without it.
 */
const WORKFLOW_READ_FACADE = "extensions/workflows/run-read.ts";

// ---------------------------------------------------------------------------
// Ledger: feature-internal modules (rule 9)
// ---------------------------------------------------------------------------

interface FeatureInternalEntry {
  readonly module: string;
  readonly destinations: readonly string[];
  readonly owner: string;
  readonly facade: string;
  readonly reason: string;
}

/**
 * A module whose OWN feature is the only extension allowed to import it, plus the
 * one file that stands in for it everywhere else.
 *
 * Rule 1 is about direction — shared code may not reach up into a feature. Rule 9
 * is about reach: two features are peers, so nothing in rule 1 stops one of them
 * from importing the other's internals, and a facade that a peer can bypass buys
 * nothing. `destinations` lists the paths the module is allowed to become, so the
 * declaration does not go stale the slice it moves; the module is asserted to exist
 * at one of them, because a declaration pointing at nothing is a rule switched off.
 *
 * Once a move has landed, `module` becomes the landed path and `destinations` goes back
 * to empty. A destination kept past its move is a second accepted path for a file that
 * has only one, and it is `module` — the path a reader treats as authoritative — that
 * would be left naming nothing.
 */
const FEATURE_INTERNAL_MODULES: readonly FeatureInternalEntry[] = [
  {
    module: "extensions/workflows/runtime/workflow-journal.ts",
    destinations: [],
    owner: "extensions/workflows",
    facade: WORKFLOW_READ_FACADE,
    reason:
      "the journal owns the run directory layout, the append sink, the journal-to-live-row projection and the live-row retention bound; a consumer that only needs to read a run must not hold the write side, so the read operations two outside consumers use are re-exported by the facade instead.",
  },
];

// ---------------------------------------------------------------------------
// Ledger: declared exceptions to rule 2
// ---------------------------------------------------------------------------

interface ProvisionalUpwardEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly clearedBy: string;
}

/**
 * Empty since W7: no edge in the tree points up the declared rank order any more, so the
 * rank order is enforced for real on every shared edge. An entry here names an edge rather
 * than papering over it by loosening a rank, because a loosened rank would silently permit
 * edges nobody reviewed. Each entry is asserted to STILL EXIST: once its slice removes the
 * edge, this list fails as stale and must shrink.
 *
 * The `runtime-capabilities -> session-core` entry went in W5, which reclassified
 * `runtime-capabilities` into the `runtime` layer (see the note on
 * SHARED_LAYER_MEMBERS.runtime). The `safe-output -> types` entry went in W7: the
 * `OUTPUT_DEFAULTS` constant `safe-output` value-imported now lives in `safe-output`
 * itself, so what was host -> mixed is host-internal.
 */
const PROVISIONAL_UPWARD_EDGES: readonly ProvisionalUpwardEdge[] = [];

// ---------------------------------------------------------------------------
// Ledger: process-global registries (rule 7)
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly symbol: string;
  readonly owner: string;
}

/**
 * Symbol string -> the ONE module allowed to name it. Verified by reading each
 * declaration site; see `artifacts/recon.md` in the task workspace for consumers
 * and the independent-entrypoint invariant each one carries.
 */
const REGISTRIES: readonly RegistryEntry[] = [
  { symbol: "locus-pi.agent-live-store.v5", owner: "extensions/_shared/agent-runtime/agent-sdk-host.ts" },
  { symbol: "locus-pi.workflow-live-executions.v1", owner: "extensions/workflows/runtime/workflow-journal.ts" },
  { symbol: "locus-pi.fleet-menu-state.v2", owner: "extensions/_shared/agent-runtime/fleet-menu.ts" },
  { symbol: "locus-pi.fleet-viewed-row.v1", owner: "extensions/_shared/agent-runtime/fleet-menu.ts" },
  { symbol: "locus-pi.command-ui-lifecycle.v2", owner: "extensions/_shared/operator/command-ui.ts" },
  { symbol: "locus-pi.operator-status.v1", owner: "extensions/_shared/operator/operator-status.ts" },
  { symbol: "locus-pi.workflow-background-runs.v1", owner: "extensions/workflows/background-run-registry.ts" },
  { symbol: "locus-pi.active-agent-session-viewers.v1", owner: "extensions/agents/session-viewer.ts" },
  { symbol: "locus-pi.viewer-external-rows.v1", owner: "extensions/_shared/operator/viewer-geometry.ts" },
  { symbol: "locus-pi.beta-config-warnings.v1", owner: "extensions/_shared/host/beta-gate.ts" },
];

/**
 * Empty by data. A registry's owning file moves when its slice runs, so a slice may
 * declare here the destination the owner path is allowed to become; until the move
 * happens the owner above stays the current path, and afterwards the sweep finds the
 * symbol at the moved path and matches the alias instead of failing as an unledgered
 * duplicate. The mechanism stays because that is the correct handling for the next
 * relocation of a registry owner.
 *
 * The five entries this held all named `extensions/_shared/<name>.ts` sources whose moves
 * had already landed, so every one of them widened its registry's accepted owner set to
 * two paths when only one existed — and the `owner` field a reader treats as the answer
 * named the gone one. The owners above are now the landed paths.
 *
 * ASSERTED NON-STALE below, for the same reason BASELINE_MUTABLE_EXPORTS is: an alias for
 * a completed move is a silent second accepted owner, which is exactly the "two modules
 * naming one slot" that rule 7 exists to catch. Fold a landed alias into `owner`.
 */
const REGISTRY_OWNER_ALIASES: Record<string, readonly string[]> = {};

// ---------------------------------------------------------------------------
// Ledger: non-symbol mutable module state (rule 8)
// ---------------------------------------------------------------------------

interface MutableStateEntry {
  readonly file: string;
  readonly binding: string;
  readonly note: string;
  readonly destinations: readonly string[];
}

/**
 * Process-visible mutable module state that the rule-7 sweep structurally cannot
 * find, because it is a plain module binding rather than a `globalThis` slot.
 * No entry here survives Pi's cache-disabled entrypoint loading — each loaded
 * entrypoint gets its own copy — so relocation must not quietly imply otherwise.
 */
const MUTABLE_MODULE_STATE: readonly MutableStateEntry[] = [
  /**
   * These two are what W7 made of `_shared/state.ts#sharedState`. That object's live fields
   * had two different owners, so it was split at field granularity into one cache per owning
   * extension rather than relocated as a unit: `agents` became the map below, and `todos` /
   * `todoContext` / `todoAutoContinue` became the three fields of the todo cache. The old
   * binding no longer exists anywhere, which is why the single entry became two.
   */
  {
    file: "extensions/agents/catalog-state.ts",
    binding: "agentCatalog",
    note: "the resolved agent catalog; `agents/catalog.ts#refreshAgents` is the only writer and rebuilds it from disk on every discovery pass.",
    destinations: [],
  },
  {
    file: "extensions/todo-context/todo-state-cache.ts",
    binding: "todoStateCache",
    note: "a cache and last-resort fallback in front of the durable session store owned by `_shared/project/todo-state`, never a source of truth; `todo-context/phase-store.ts` is the only writer.",
    destinations: [],
  },
  {
    file: "extensions/ast-structural-edit/ast-engine.ts",
    binding: "pythonRegistered",
    note: "module-level `let` guarding a one-shot ast-grep dynamic language registration; single-owner, moved with its module in W6.",
    destinations: [],
  },
];

/**
 * Rule 8's second half is a NEW-binding detector, and it is deliberately narrow.
 *
 * WHAT IT CATCHES: a module-level `export let` / `export var` in `_shared` (always
 * rebindable), and a module-level `export const` whose initializer is a bare
 * object or array literal that is neither `as const`, nor `Object.freeze(...)`,
 * nor annotated `readonly`/`Readonly<>`/`ReadonlyArray<>` — i.e. a container the
 * type system lets any importer mutate.
 *
 * WHAT IT DOES NOT CATCH, and why not: a non-exported module `let` (that is how
 * `ast-engine.ts#pythonRegistered` hides, which is exactly why the declared ledger
 * above exists alongside this detector); `new Map()` / `new Set()` / factory-call
 * initializers, because deciding whether one is a frozen lookup table or live
 * state needs dataflow analysis this script does not do; and mutation of a nested
 * property inside an `as const` object. A detector that guessed at those would
 * fire on the ~60 legitimate frozen constants in `_shared` and be switched off
 * within a week, which is worth less than a narrow rule that is always right.
 *
 * Entries below are pre-existing structurally-mutable containers inside the
 * detector's scope. They are an ACKNOWLEDGED BASELINE, not a semantic ledger: each
 * is populated once at module init and never written again, so they carry no
 * cross-entrypoint meaning. They are listed so the detector starts at zero noise
 * and any NEW mutable export fails.
 *
 * KEYED BY FULL PATH, on purpose. An earlier version keyed on the basename, which
 * meant an entry naming a module that had since left `_shared` kept granting an
 * exemption to any future `_shared` file with the same basename — a rule silently
 * switched off by a file that no longer exists. Every entry is now asserted to
 * still match a detected binding, so a relocation that empties this map fails here
 * instead of leaving a dead exemption behind. The map is currently empty: the three
 * original entries named modules that moved out to their owning extensions, and
 * outside `_shared` they are no longer the detector's business.
 */
const BASELINE_MUTABLE_EXPORTS: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SHARED_DIR = "extensions/_shared";
const EXTENSIONS_DIR = "extensions";
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js"]);

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await checkExtensionLayers(process.cwd());
}

interface Classification {
  readonly kind: "shared" | "feature";
  readonly layer?: SharedLayer;
  readonly destination: string;
}

interface ImportEdge {
  readonly line: number;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export async function checkExtensionLayers(root: string): Promise<void> {
  const failures: string[] = [];
  const ledger = buildLedger(failures);
  const sharedFiles = await listFiles(path.join(root, SHARED_DIR), root);
  const sharedSources = sharedFiles.filter((file) => file.endsWith(".ts"));

  const byBasename = new Map<string, string>();
  for (const file of sharedSources) {
    const name = path.basename(file, ".ts");
    const previous = byBasename.get(name);
    if (previous) {
      failures.push(
        `ambiguous ledger key: ${previous} and ${file} share the basename "${name}"; ` +
          `the ledger is keyed by basename, so two shared modules may not share one.`,
      );
      continue;
    }
    byBasename.set(name, file);
  }

  // Rule 5: no unledgered file.
  for (const [name, file] of byBasename) {
    if (!ledger.has(name)) {
      failures.push(
        `rule 5 (no unledgered file): ${file} has no ownership ledger entry. ` +
          `Add "${name}" to a _shared layer in SHARED_LAYER_MEMBERS or to FEATURE_DESTINATIONS ` +
          `in scripts/check-extension-layers.ts, and record the decision in the task ownership ledger.`,
      );
    }
  }

  // Rule 4: destination reached for every ledger entry no longer in _shared.
  const pending: string[] = [];
  for (const [name, classification] of ledger) {
    const present = byBasename.get(name);
    if (present) {
      if (classification.kind === "feature") pending.push(name);
      continue;
    }
    // A provisional-layer member is shredded by domain, not moved: its exports go
    // to several owners and the synthesized `_shared/<layer>/<name>.ts` destination
    // is never meant to exist. Demanding it would fail the very slice that does the
    // job correctly, so the requirement is the opposite one — retire the entry.
    if (classification.kind === "shared" && classification.layer && isProvisionalLayer(classification.layer)) {
      failures.push(
        `rule 4 (destination reached): provisional entry "${name}" is gone from ${SHARED_DIR}/ but is still declared ` +
          `in the "${classification.layer}" layer. A provisional module is split across owners rather than moved, so ` +
          `it has no single destination: delete "${name}" from SHARED_LAYER_MEMBERS.${classification.layer} in the ` +
          `same change that shreds it, and remove the layer once it is empty.`,
      );
      continue;
    }
    if (!(await fileExists(path.join(root, classification.destination)))) {
      failures.push(
        `rule 4 (destination reached): ledger entry "${name}" is gone from ${SHARED_DIR}/ but its declared ` +
          `destination ${classification.destination} does not exist. The slice that removed it did not land it.`,
      );
    }
  }
  if (!byBasename.has("workflow-journal") && !(await fileExists(path.join(root, WORKFLOW_READ_FACADE)))) {
    failures.push(
      `rule 4 (destination reached): workflow-journal has left ${SHARED_DIR}/ but the declared read facade ` +
        `${WORKFLOW_READ_FACADE} does not exist. W2 landed it and W3 moved the journal behind it; deleting the ` +
        `facade now leaves every outside consumer with no sanctioned way to read a run.`,
    );
  }

  // Rules 1, 2, 6 and the mutable-export detector need each file's parsed source.
  const seenUpwardEdges = new Set<string>();
  const matchedBaselineExports = new Set<string>();
  for (const file of sharedSources) {
    const name = path.basename(file, ".ts");
    const classification = ledger.get(name);
    const text = await readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));

    // Rule 6: subdirectory agreement.
    const relativeToShared = path.relative(SHARED_DIR, file).split(path.sep);
    if (relativeToShared.length > 1) {
      const directory = relativeToShared[0];
      if (!classification) {
        // Rule 5 already reported it.
      } else if (classification.kind === "feature") {
        failures.push(
          `rule 6 (subdirectory agreement): ${file} is classified feature:${classification.destination}, ` +
            `which has no _shared layer, so it may not sit in a _shared subdirectory. Move it to its destination.`,
        );
      } else if (directory !== classification.layer) {
        failures.push(
          `rule 6 (subdirectory agreement): ${file} sits in _shared/${directory}/ but is classified ` +
            `shared:${classification.layer}. The directory must equal the declared layer.`,
        );
      }
    }

    for (const edge of collectImportEdges(source)) {
      if (!edge.specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(file, edge.specifier);
      const kindLabel = edge.typeOnly ? "type-only import" : "value import";

      // Rule 1: no upward import.
      if (!isInside(resolved, SHARED_DIR)) {
        failures.push(
          `rule 1 (no upward import): ${file}:${edge.line} ${kindLabel} of "${edge.specifier}" escapes ` +
            `${SHARED_DIR}/ and resolves to ${resolved}. Foundational shared code may never import a feature ` +
            `directory; invert the dependency or move this file out of ${SHARED_DIR}/.`,
        );
        continue;
      }

      if (!classification || classification.kind === "feature") continue; // rule 3

      const targetName = path.basename(resolved).replace(/\.(?:js|ts)$/, "");
      const target = ledger.get(targetName);
      if (!target) continue; // rule 5 reports the missing entry
      if (target.kind === "feature") {
        failures.push(
          `rule 2 (layer order): ${file}:${edge.line} is shared:${classification.layer} and ${kindLabel}s ` +
            `"${edge.specifier}", which is classified feature:${target.destination}. A shared layer may not ` +
            `depend on a module that is leaving for a feature directory.`,
        );
        continue;
      }

      const fromLayer = classification.layer;
      const toLayer = target.layer;
      if (!fromLayer || !toLayer) continue;
      if (layerImportAllowed(fromLayer, toLayer)) continue;

      const exemption = PROVISIONAL_UPWARD_EDGES.find((entry) => entry.from === name && entry.to === targetName);
      if (exemption) {
        seenUpwardEdges.add(`${exemption.from} -> ${exemption.to}`);
        continue;
      }
      failures.push(
        `rule 2 (layer order): ${file}:${edge.line} is shared:${fromLayer} (rank ${LAYER_RANK[fromLayer]}) and ` +
          `${kindLabel}s "${edge.specifier}", which is shared:${toLayer} (rank ${LAYER_RANK[toLayer]}). ` +
          `${describeAllowedTargets(fromLayer)} A type-only edge still encodes ownership and is not exempt.`,
      );
    }

    // Rule 8, second half: undeclared mutable exported container.
    if (relativeToShared.length >= 1) {
      for (const binding of collectMutableExports(source)) {
        const key = `${file}#${binding.name}`;
        if (key in BASELINE_MUTABLE_EXPORTS) {
          matchedBaselineExports.add(key);
          continue;
        }
        const declared = MUTABLE_MODULE_STATE.some(
          (entry) => (entry.file === file || entry.destinations.includes(file)) && entry.binding === binding.name,
        );
        if (declared) continue;
        failures.push(
          `rule 8 (mutable module state): ${file}:${binding.line} exports mutable module-level binding ` +
            `"${binding.name}" (${binding.reason}), which is not declared. Mutable module state does not survive ` +
            `Pi's cache-disabled entrypoint loading: either make it immutable (\`as const\`, \`Object.freeze\`, a ` +
            `\`readonly\` annotation), promote it to a versioned globalThis registry and add it to REGISTRIES, or ` +
            `declare it in MUTABLE_MODULE_STATE with its owner and destination.`,
        );
      }
    }
  }

  for (const key of Object.keys(BASELINE_MUTABLE_EXPORTS)) {
    if (matchedBaselineExports.has(key)) continue;
    failures.push(
      `stale baseline: the acknowledged mutable export ${key} was not detected in ${SHARED_DIR}/. Either it became ` +
        `immutable, or its module left the shared directory and the detector no longer covers it. Delete the entry — ` +
        `a baseline keyed on a file that is no longer scanned is an exemption nobody reviews.`,
    );
  }

  for (const exemption of PROVISIONAL_UPWARD_EDGES) {
    const key = `${exemption.from} -> ${exemption.to}`;
    if (seenUpwardEdges.has(key)) continue;
    failures.push(
      `stale exemption: the declared provisional upward edge ${key} no longer exists in the tree. ` +
        `${exemption.clearedBy} has cleared it — delete the entry from PROVISIONAL_UPWARD_EDGES so the rank order ` +
        `is enforced for real.`,
    );
  }

  // Rule 8, first half: declared mutable state still present where declared.
  for (const entry of MUTABLE_MODULE_STATE) {
    const located = await locateBinding(root, entry);
    if (located) continue;
    failures.push(
      `rule 8 (mutable module state): declared binding "${entry.binding}" was not found in ${entry.file} or in ` +
        `any declared destination (${entry.destinations.join(", ")}). ${entry.note} A slice may not relocate it ` +
        `silently — update MUTABLE_MODULE_STATE in the same change.`,
    );
  }

  // Rule 7: registry inventory.
  failures.push(...(await checkRegistries(root)));

  // Rule 9: feature-internal module reached from another feature.
  failures.push(...(await checkFeatureInternalModules(root)));

  if (failures.length > 0) {
    console.error(`Extension layer check failed with ${failures.length} violation(s):\n\n${failures.join("\n\n")}`);
    process.exitCode = 1;
    return;
  }

  const layerCount = Object.keys(SHARED_LAYER_MEMBERS).length;
  const provisional = PROVISIONAL_LAYERS.filter((layer) => SHARED_LAYER_MEMBERS[layer].length > 0);
  console.log(
    `Extension layers verified: ${sharedSources.length} shared source(s) across ${layerCount} declared layer(s), ` +
      `${pending.length} awaiting relocation, ${REGISTRIES.length} process-global registries, ` +
      `${MUTABLE_MODULE_STATE.length} ledgered mutable module bindings, ` +
      `${FEATURE_INTERNAL_MODULES.length} feature-internal module(s) behind a facade, ` +
      `${PROVISIONAL_UPWARD_EDGES.length} declared provisional upward edge(s)` +
      `${provisional.length > 0 ? `, provisional layer(s) still present: ${provisional.join(", ")}` : ""}.`,
  );
}

function buildLedger(failures: string[]): Map<string, Classification> {
  const ledger = new Map<string, Classification>();
  for (const [layer, members] of Object.entries(SHARED_LAYER_MEMBERS) as [SharedLayer, readonly string[]][]) {
    for (const name of members) {
      const previous = ledger.get(name);
      if (previous) {
        failures.push(
          `ledger conflict: "${name}" is declared in two places (${describeClassification(previous)} and shared:${layer}). ` +
            `A module has exactly one owner.`,
        );
        continue;
      }
      ledger.set(name, { kind: "shared", layer, destination: `${SHARED_DIR}/${layer}/${name}.ts` });
    }
  }
  for (const [name, destination] of Object.entries(FEATURE_DESTINATIONS)) {
    const previous = ledger.get(name);
    if (previous) {
      failures.push(
        `ledger conflict: "${name}" is declared in two places (${describeClassification(previous)} and feature:${destination}). ` +
          `A module has exactly one owner.`,
      );
      continue;
    }
    ledger.set(name, { kind: "feature", destination });
  }
  return ledger;
}

function isProvisionalLayer(layer: SharedLayer): boolean {
  return PROVISIONAL_LAYERS.includes(layer);
}

function describeClassification(classification: Classification): string {
  return classification.kind === "shared" ? `shared:${classification.layer}` : `feature:${classification.destination}`;
}

function layerImportAllowed(from: SharedLayer, to: SharedLayer): boolean {
  if (from === "operator") return to === "host" || to === "operator";
  if (to === "operator") return false;
  return LAYER_RANK[to] <= LAYER_RANK[from];
}

function describeAllowedTargets(from: SharedLayer): string {
  if (from === "operator") {
    return "The operator layer may import only the host layer and itself, by declared contract.";
  }
  const allowed = (Object.keys(LAYER_RANK) as SharedLayer[])
    .filter((layer) => layerImportAllowed(from, layer))
    .sort((a, b) => LAYER_RANK[a] - LAYER_RANK[b] || a.localeCompare(b));
  return `shared:${from} may import only: ${allowed.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Source analysis
// ---------------------------------------------------------------------------

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".mjs" || extension === ".js") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function collectImportEdges(source: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        line: lineOf(source, node),
        specifier: node.moduleSpecifier.text,
        typeOnly: node.importClause?.isTypeOnly === true,
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ line: lineOf(source, node), specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      edges.push({ line: lineOf(source, node), specifier: node.argument.literal.text, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        edges.push({ line: lineOf(source, node), specifier: argument.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return edges;
}

interface MutableBinding {
  readonly name: string;
  readonly line: number;
  readonly reason: string;
}

function collectMutableExports(source: ts.SourceFile): MutableBinding[] {
  const bindings: MutableBinding[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      const line = lineOf(source, declaration);
      if (!isConst) {
        bindings.push({ name, line, reason: "`export let`/`export var` is rebindable by its own module" });
        continue;
      }
      const initializer = declaration.initializer;
      if (!initializer) continue;
      if (!isBareMutableLiteral(initializer)) continue;
      if (declaration.type && isReadonlyTypeNode(declaration.type)) continue;
      bindings.push({
        name,
        line,
        reason:
          "`export const` of a bare object/array literal with no `as const`, `Object.freeze`, or readonly annotation",
      });
    }
  }
  return bindings;
}

function isBareMutableLiteral(node: ts.Expression): boolean {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return false;
  return ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node);
}

function isReadonlyTypeNode(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.ReadonlyKeyword) return true;
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return true;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const typeName = node.typeName.text;
    if (
      typeName === "Readonly" ||
      typeName === "ReadonlyArray" ||
      typeName === "ReadonlyMap" ||
      typeName === "ReadonlySet"
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registries and mutable state
// ---------------------------------------------------------------------------

async function checkRegistries(root: string): Promise<string[]> {
  const failures: string[] = [];
  const sources = (await listFiles(path.join(root, EXTENSIONS_DIR), root)).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const found = new Map<string, { file: string; line: number }[]>();

  for (const file of sources) {
    const text = await readFile(path.join(root, file), "utf8");
    if (!text.includes("Symbol.for")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Symbol" &&
        node.expression.name.text === "for" &&
        node.arguments.length === 1
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument) && argument.text.startsWith("locus-pi.")) {
          found.set(argument.text, [...(found.get(argument.text) ?? []), { file, line: lineOf(source, node) }]);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  for (const [symbol, sites] of found) {
    const declared = REGISTRIES.find((entry) => entry.symbol === symbol);
    if (!declared) {
      failures.push(
        `rule 7 (registry inventory): undeclared process-global registry Symbol.for("${symbol}") at ` +
          `${sites.map((site) => `${site.file}:${site.line}`).join(", ")}. Every versioned globalThis slot must be ` +
          `declared in REGISTRIES with its owning module, so a reviewer can see who owns process-wide state.`,
      );
      continue;
    }
    const allowedOwners = [declared.owner, ...(REGISTRY_OWNER_ALIASES[declared.owner] ?? [])];
    const strays = sites.filter((site) => !allowedOwners.includes(site.file));
    if (strays.length > 0) {
      failures.push(
        `rule 7 (registry inventory): Symbol.for("${symbol}") is declared owned by ${declared.owner} but is also ` +
          `named at ${strays.map((site) => `${site.file}:${site.line}`).join(", ")}. Two modules naming one registry ` +
          `slot is how a relocation duplicates process-global state; keep exactly one owner, or update REGISTRIES ` +
          `and REGISTRY_OWNER_ALIASES if the owner legitimately moved.`,
      );
    }
  }

  for (const entry of REGISTRIES) {
    if (found.has(entry.symbol)) continue;
    failures.push(
      `rule 7 (registry inventory): declared registry Symbol.for("${entry.symbol}") owned by ${entry.owner} was not ` +
        `found anywhere under ${EXTENSIONS_DIR}/. Either it was deleted — which changes process-wide behavior and ` +
        `needs its own decision — or it was renamed without updating REGISTRIES.`,
    );
  }

  // Stale owner alias. An alias exists only for the window in which a registry owner is
  // moving; once the move lands it is a second accepted owner path for a file that has
  // one, and nothing else here would notice.
  for (const [owner, aliases] of Object.entries(REGISTRY_OWNER_ALIASES)) {
    if (!REGISTRIES.some((entry) => entry.owner === owner)) {
      failures.push(
        `stale alias: REGISTRY_OWNER_ALIASES declares aliases for "${owner}", which is not the owner of any entry in ` +
          `REGISTRIES. An alias keyed on a path no owner uses grants an exemption nobody reviews — delete it.`,
      );
      continue;
    }
    if (await fileExists(path.join(root, owner))) continue;
    const landed: string[] = [];
    for (const alias of aliases) {
      if (await fileExists(path.join(root, alias))) landed.push(alias);
    }
    if (landed.length !== 1) continue;
    failures.push(
      `stale alias: the declared owner ${owner} no longer exists and its registry now lives at ${landed[0]}. The move ` +
        `has landed: set that path as the entry's \`owner\` in REGISTRIES and delete the alias, so exactly one module ` +
        `path is accepted for the slot.`,
    );
  }

  return failures;
}

async function checkFeatureInternalModules(root: string): Promise<string[]> {
  const failures: string[] = [];
  if (FEATURE_INTERNAL_MODULES.length === 0) return failures;

  const sources = (await listFiles(path.join(root, EXTENSIONS_DIR), root)).filter((file) =>
    SOURCE_EXTENSIONS.has(path.extname(file)),
  );
  const located: { entry: FeatureInternalEntry; at: string }[] = [];

  for (const entry of FEATURE_INTERNAL_MODULES) {
    const candidates = [entry.module, ...entry.destinations];
    const at = await firstExisting(root, candidates);
    if (at === undefined) {
      failures.push(
        `rule 9 (feature-internal module): declared internal module ${entry.module} was not found at its declared ` +
          `path or any declared destination (${entry.destinations.join(", ")}). A declaration pointing at nothing is ` +
          `a rule switched off: update FEATURE_INTERNAL_MODULES in the same change that moves or renames it.`,
      );
      continue;
    }
    if (!(await fileExists(path.join(root, entry.facade)))) {
      failures.push(
        `rule 9 (feature-internal module): ${at} is declared internal to ${entry.owner}/ with facade ${entry.facade}, ` +
          `but that facade file does not exist. Without it every other extension is left with no sanctioned way to ` +
          `read what the module owns.`,
      );
      continue;
    }
    located.push({ entry, at });
  }
  if (located.length === 0) return failures;

  for (const file of sources) {
    // `_shared` siblings are governed by rules 1-3; see the SCOPE note.
    if (isInside(file, SHARED_DIR)) continue;
    const text = await readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    for (const edge of collectImportEdges(source)) {
      if (!edge.specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(file, edge.specifier);
      for (const { entry, at } of located) {
        if (!sameModule(resolved, at)) continue;
        if (isInside(file, entry.owner) || file === entry.facade) continue;
        failures.push(
          `rule 9 (feature-internal module): ${file}:${edge.line} ${edge.typeOnly ? "type-only import" : "value import"} ` +
            `of "${edge.specifier}" resolves to ${at}, which is declared internal to ${entry.owner}/. ` +
            `Import ${entry.facade} instead, adding the symbol to it if it is missing — ${entry.reason}`,
        );
      }
    }
  }

  return failures;
}

async function firstExisting(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await fileExists(path.join(root, candidate))) return candidate;
  }
  return undefined;
}

/** Compare an import target with a source path, ignoring the ESM `.js`-for-`.ts` spelling. */
function sameModule(resolved: string, modulePath: string): boolean {
  return stripSourceExtension(resolved) === stripSourceExtension(modulePath);
}

function stripSourceExtension(value: string): string {
  return value.replace(/\.(?:mts|mjs|ts|js)$/, "");
}

async function locateBinding(root: string, entry: MutableStateEntry): Promise<boolean> {
  for (const candidate of [entry.file, ...entry.destinations]) {
    let text: string;
    try {
      text = await readFile(path.join(root, candidate), "utf8");
    } catch {
      continue;
    }
    const source = ts.createSourceFile(candidate, text, ts.ScriptTarget.Latest, true, scriptKindFor(candidate));
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === entry.binding)
        found = true;
      else ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    if (found) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveSpecifier(fromFile: string, specifier: string): string {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(fromFile)), specifier));
  return resolved;
}

function isInside(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    const entryStat = await stat(absolutePath);
    return entryStat.isFile();
  } catch {
    return false;
  }
}

async function listFiles(absoluteDirectory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolutePath, root)));
    else if (entry.isFile()) files.push(toPosix(path.relative(root, absolutePath)));
  }
  return files.sort();
}
