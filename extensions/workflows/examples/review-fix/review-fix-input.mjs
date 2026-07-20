import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

// The review report is a human-edited document, not an immutable artifact.
// Deterministic code therefore proves only what a prompt cannot: that the
// operator named one confined review.md inside a task artifacts directory and
// that it still lists at least one finding. Whether each finding is still real
// is decided by the fix agents against live source, not by this module.
export function loadReviewFixRequest(projectRoot, input) {
  const root = realpathSync(projectRoot);
  const originalRequest = typeof input === "string" ? input.trim() : "";
  if (originalRequest === "") {
    throw new Error("review-fix requires one explicit project-relative review.md path");
  }
  const requestedPath = findReviewPathToken(originalRequest);

  const reviewPath = resolveProjectFile(root, requestedPath, "review.md");
  const artifactsDirectory = path.dirname(reviewPath);
  if (path.basename(artifactsDirectory) !== "artifacts") {
    throw new Error(`review-fix review.md must live in a task artifacts directory: ${requestedPath}`);
  }
  const taskDirectory = path.dirname(artifactsDirectory);
  const reviewText = readFileSync(reviewPath, "utf8");
  const findingIds = parseFindingIds(reviewText, requestedPath);

  return {
    projectRoot: root,
    originalRequest,
    taskId: path.basename(taskDirectory),
    taskPath: posixRelative(root, taskDirectory),
    artifactsPath: posixRelative(root, artifactsDirectory),
    reviewPath: posixRelative(root, reviewPath),
    fixReportPath: posixRelative(root, path.join(artifactsDirectory, "fix-report.md")),
    findingIds,
    reviewText,
  };
}

// The operator may wrap the path in ordinary instructions such as
// "apply only the P1 items in .tasks/T-1/artifacts/review.md". Deterministic
// code extracts the one addressable artifact; the scope resolver interprets
// everything else.
function findReviewPathToken(request) {
  const tokens = request
    .split(/\s+/u)
    .map((token) => token.replace(/^[`'"(<[]+|[`'")>\],.;:]+$/gu, ""))
    .filter((token) => token !== "");
  const candidates = tokens.filter((token) => path.basename(token) === "review.md");
  if (candidates.length === 0) {
    throw new Error(`review-fix input must name one review.md path: ${request}`);
  }
  if (new Set(candidates).size > 1) {
    throw new Error(`review-fix input names more than one review.md path: ${candidates.join(", ")}`);
  }
  return candidates[0];
}

// Human edits are the approval signal: a deleted finding is a rejected
// finding, and free-form notes stay inside the block for the fix agent to read.
// Only the heading id is parsed, so reworded titles and added notes survive.
function parseFindingIds(text, requestedPath) {
  const startMatch = /^##\s+Findings\s*$/m.exec(text);
  if (startMatch === null) {
    throw new Error(`review-fix review.md has no "## Findings" section: ${requestedPath}`);
  }
  const rest = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = /^##\s+/m.exec(rest);
  const body = endMatch === null ? rest : rest.slice(0, endMatch.index);
  const ids = [...body.matchAll(/^###\s+([A-Za-z0-9._-]+)\b/gm)].map((match) => match[1]);
  if (ids.length === 0) {
    throw new Error(`review-fix found no remaining findings to apply in ${requestedPath}`);
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`review-fix duplicate finding id in ${requestedPath}: ${duplicates[0]}`);
  }
  return ids;
}

function resolveProjectFile(projectRoot, relativePath, expectedBasename) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`review-fix artifact path must be project-relative: ${relativePath}`);
  }
  const lexical = path.resolve(projectRoot, relativePath);
  if (!isWithin(projectRoot, lexical)) {
    throw new Error(`review-fix artifact path escapes project root: ${relativePath}`);
  }
  if (!existsSync(lexical) || !statSync(lexical).isFile()) {
    throw new Error(`review-fix artifact is missing: ${relativePath} -> ${lexical}`);
  }
  const physical = realpathSync(lexical);
  if (!isWithin(projectRoot, physical)) {
    throw new Error(`review-fix artifact escapes project root through a symlink: ${relativePath}`);
  }
  if (path.basename(physical) !== expectedBasename) {
    throw new Error(`review-fix expected ${expectedBasename}: ${relativePath}`);
  }
  return physical;
}

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
