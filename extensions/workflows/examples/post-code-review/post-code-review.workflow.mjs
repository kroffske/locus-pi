export const meta = {
  name: "post-code-review",
  description: "Run modular post-code review lanes and publish the synthesis report.",
  profile: "standard",
  phases: [
    { title: "Scope" },
    { title: "Parallel audits" },
    { title: "Necessity challenge" },
    { title: "Synthesis" },
    { title: "Publish" },
  ],
};

export default async function runWorkflow(dsl, input) {
  const keys = ["scope", "boundaries", "simplicity", "contracts", "necessity", "synthesis"];
  const outputDir = dsl.outputDir();

  dsl.phase("scope");
  await dsl.invokeWorkflow({
    packageName: "post-code-review-scope",
    input,
    keys,
    key: "scope",
    outputDir,
  });

  dsl.phase("audit-barrier");
  await dsl.parallel([
    () =>
      dsl.invokeWorkflow({
        packageName: "post-code-review-boundaries",
        input,
        keys,
        key: "boundaries",
        outputDir,
      }),
    () =>
      dsl.invokeWorkflow({
        packageName: "post-code-review-simplicity",
        input,
        keys,
        key: "simplicity",
        outputDir,
      }),
    () =>
      dsl.invokeWorkflow({
        packageName: "post-code-review-contracts",
        input,
        keys,
        key: "contracts",
        outputDir,
      }),
  ]);

  dsl.phase("necessity");
  await dsl.invokeWorkflow({
    packageName: "post-code-review-necessity",
    input,
    keys,
    key: "necessity",
    outputDir,
  });

  dsl.phase("synthesis");
  await dsl.invokeWorkflow({
    packageName: "post-code-review-synthesis",
    input,
    keys,
    key: "synthesis",
    outputDir,
  });

  dsl.phase("publish");
  return dsl.publishPrimaryFile("post-code-review.md");
}
