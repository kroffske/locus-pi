export const meta = {
  name: "workflow-creator",
  description: "Create an accepted workflow Design and SVG, then build and verify its source package.",
  profile: "standard",
  phases: [{ title: "design" }, { title: "svg" }, { title: "build" }, { title: "publish" }],
};

const CHILD_KEYS = ["design", "svg", "build"];

export default async function runWorkflow(dsl, input) {
  const sharedOutputDir = dsl.outputDir();

  dsl.phase("design");
  await dsl.invokeWorkflow({
    child: "design",
    key: "design",
    keys: CHILD_KEYS,
    input,
    outputDir: sharedOutputDir,
  });

  dsl.phase("svg");
  await dsl.invokeWorkflow({
    child: "svg",
    key: "svg",
    keys: CHILD_KEYS,
    input,
    outputDir: sharedOutputDir,
  });

  dsl.phase("build");
  await dsl.invokeWorkflow({
    child: "build",
    key: "build",
    keys: CHILD_KEYS,
    input,
    outputDir: sharedOutputDir,
  });

  dsl.phase("publish");
  return dsl.publishPrimaryFile("workflow-package.md");
}
