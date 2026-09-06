export const meta = {
  name: "decomposition",
  description: "Bounded discovery followed by ordered independent work",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  const units = await dsl.agent(
    `Discover independent complete work handoffs for this goal; no more than four units:\n${input}`,
    {
      label: "discover",
      handoffs: { minItems: 1, maxItems: 4, maxItemChars: 4000 },
    },
  );
  const results = await dsl.parallel(
    units.map((unit) => async () => dsl.agent(`Perform only this work unit:\n${unit}`, { label: "unit-worker" })),
    {
      concurrency: 2,
      title: "Independent discovered units",
    },
  );
  const result = await dsl.agent(
    `Combine the ordered results without silently dropping unresolved work.\nGoal:\n${input}\nResults:\n${results.join("\n\n")}`,
    { label: "combine" },
  );
  return dsl.publishPrimaryArtifact("result.md", result);
}
