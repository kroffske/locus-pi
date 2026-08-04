// live-smoke.workflow.mjs
// Minimal LIVE proof that the runtime really spawns child agent sessions.
// Two agents each perform a small tool action (so they pass the
// honesty gate, which rejects "completed" with zero tool activity) and return a
// one-line note. The workflow returns both exact notes; per-agent status and
// session evidence remain runtime-owned in journal events and child artifacts.
//
export const meta = {
  name: "live-smoke",
  profile: "standard",
  description: "Checks that the Pi host can spawn full-tool workflow agents and collect their reports.",
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const topic = typeof input === "string" && input.trim() ? input.trim() : "runtime smoke test";

  phase("smoke");
  log(`Live smoke for: ${topic}`);

  const explore = await agent(
    `Use your find tool to list the files in the current working directory, ` +
      `then reply in ONE short sentence: name yourself ("explore") and say how many entries you found. Topic: ${topic}.`,
    { agent: "explore", label: "list cwd entries", workspaceMode: "project" },
  );
  const quick = await agent(
    `Use your find tool to list the files in the current working directory, ` +
      `then reply in ONE short sentence: name yourself ("quick_task") and say how many entries you found. Topic: ${topic}.`,
    { agent: "quick_task", label: "list cwd entries", workspaceMode: "project" },
  );

  return {
    topic,
    ok: true,
    notes: {
      explore,
      quick_task: quick,
    },
  };
}
