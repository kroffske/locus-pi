// live-smoke.workflow.mjs
// Minimal LIVE proof that the runtime really spawns child agent sessions.
// Two read-only agents each perform a small tool action (so they pass the
// honesty gate, which rejects "completed" with zero tool activity) and return a
// one-line note. The workflow returns both exact notes; per-agent status and
// session evidence remain runtime-owned in journal events and child artifacts.
//
// TODO(iteration-2026-07-21): "read-only" above is FALSE, and this is the file
// authors copy first. The calls pass no `readOnly` and no `tools`, only
// `permissionMode: "agent-defined"` — and `quick_task` is a full-tool agent
// (edit/write/bash). The prompt also tells `explore` to use "bash", which it does
// not have. Fix: declare the capability limits in the DSL and correct the header,
// or rename what this example claims to demonstrate. Deferred on purpose: child
// permissions are explicitly not a concern this iteration (MVP = one working
// chain of agents), so this is unpaid debt, not an accepted pattern.
// See `.locus/reviews/2026-07-21-workflow-dsl/reconciliation-1.md` (A2, S2) and
// the 2026-07-21 entry in `.locus/soul.md` `## Direction log`.

export const meta = {
  name: "live-smoke",
  description: "Checks that the Pi host can spawn read-only workflow agents and collect their reports.",
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const topic = typeof input === "string" && input.trim() ? input.trim() : "runtime smoke test";

  phase("smoke");
  log(`Live smoke for: ${topic}`);

  const ask = (who) =>
    agent(
      `Use your read/bash tools to list the files in the current working directory, ` +
        `then reply in ONE short sentence: name yourself ("${who}") and say how many entries you found. Topic: ${topic}.`,
      // Label describes the TASK (glossary standard), not the agent — the actor is
      // already shown as `agentName#id` in the live row (T-188 W3).
      { agent: who, label: "list cwd entries", permissionMode: "agent-defined" },
    );

  const explore = await ask("explore");
  const quick = await ask("quick_task");

  return {
    topic,
    ok: true,
    notes: {
      explore,
      quick_task: quick,
    },
  };
}
