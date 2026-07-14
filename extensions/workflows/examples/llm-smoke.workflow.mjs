// llm-smoke.workflow.mjs
// Minimal LIVE proof that the runtime can call the model DIRECTLY via dsl.llm()
// — direct model completions, NO child agent session. Exercises all four llm()
// surfaces: plain, system-prompt, streaming (llm_delta), and schema= (validated
// JSON -> result.output). VERIFIABLE: check
// .locus/runtime/workflows/<runId>/result.json (real text + classified.output)
// and journal.ndjson (llm_start/llm_end + llm_delta on the streamed call).

export const meta = {
  name: "llm-smoke",
  description: "Exercises direct-model workflow calls, streaming, system prompts, and schema validation.",
};

export default async function runWorkflow(dsl, input) {
  const { llm, phase, log } = dsl;
  const topic = typeof input === "string" && input.trim() ? input.trim() : "a haiku about deterministic workflows";

  phase("llm-smoke");
  log(`Direct llm() calls for: ${topic}`);

  // 1. One direct model completion — no agent, no tools.
  const reply = await llm(`In ONE short sentence, ${topic}.`, { label: "direct" });

  // 2. A call with a system prompt, to exercise the Context.systemPrompt path.
  const constrained = await llm(`Name yourself and say "ok".`, {
    system: "You are a terse workflow smoke probe. Answer in under 8 words.",
    label: "system",
  });

  // 3. A streamed call — forwards text chunks as llm_delta journal events.
  const streamed = await llm(`List three one-word benefits of determinism, one per line.`, {
    stream: true,
    label: "streamed",
  });

  // 4. A schema= call — validated JSON parsed into result.output.
  const classified = await llm(
    `Classify the sentiment of the phrase "I really love this" as JSON {"label": one of "positive","negative","neutral"}. Reply with ONLY the JSON object.`,
    {
      label: "schema",
      schema: {
        type: "object",
        required: ["label"],
        properties: { label: { type: "string", enum: ["positive", "negative", "neutral"] } },
      },
    },
  );

  return {
    topic,
    ok: Boolean(reply?.ok && constrained?.ok && streamed?.ok && classified?.ok),
    direct: {
      text: reply?.text ?? null,
      stopReason: reply?.stopReason ?? null,
      model: reply?.model ?? null,
      usage: reply?.usage ?? null,
    },
    system: { text: constrained?.text ?? null },
    streamed: { text: streamed?.text ?? null, stopReason: streamed?.stopReason ?? null },
    classified: { ok: classified?.ok ?? false, output: classified?.output ?? null, text: classified?.text ?? null },
  };
}
