// live-smoke.workflow.mjs
// Minimal LIVE proof that the runtime really spawns child agent sessions.
// Two agents each perform a small tool action (so they pass the
// honesty gate, which rejects "completed" with zero tool activity) and return a
// one-line note. The workflow returns both exact notes; per-agent status and
// session evidence remain runtime-owned in journal events and child artifacts.
//
export const meta = {
  name: "live-smoke",
  description: "Checks that the Pi host can spawn full-tool workflow agents and collect their reports.",
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const topic = typeof input === "string" && input.trim() ? input.trim() : "runtime smoke test";

  phase("smoke");
  log(`Live smoke for: ${topic}`);

  const ask = (who) =>
    agent(
      `Use your find tool to list the files in the current working directory, ` +
        `then reply in ONE short sentence: name yourself ("${who}") and say how many entries you found. Topic: ${topic}.`,
      // Label describes the TASK (glossary standard), not the agent — the actor is
      // already shown as `agentName#id` in the live row (T-188 W3).
      {
        agent: who,
        label: "list cwd entries",
        workspaceMode: "project",
      },
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
