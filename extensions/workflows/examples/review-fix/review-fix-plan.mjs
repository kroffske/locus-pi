import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const DISPOSITIONS = new Set(["accepted", "waived", "deferred", "pending"]);
const SHA256 = /^[0-9a-f]{64}$/;

export function loadApprovedReviewPlan(projectRoot, input) {
  const root = realpathSync(projectRoot);
  const requestedPath = typeof input === "string" ? input.trim() : "";
  if (requestedPath === "") {
    throw new Error("review-fix requires one explicit project-relative fix-plan.md path");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new Error(`review-fix fix-plan path must be project-relative: ${requestedPath}`);
  }
  if (path.basename(requestedPath) !== "fix-plan.md") {
    throw new Error(`review-fix input must name fix-plan.md: ${requestedPath}`);
  }

  const fixPlanPath = resolveProjectFile(root, requestedPath, "fix-plan.md");
  const artifactsDirectory = path.dirname(fixPlanPath);
  if (path.basename(artifactsDirectory) !== "artifacts") {
    throw new Error(`review-fix fix-plan.md must live in a task artifacts directory: ${requestedPath}`);
  }
  const taskDirectory = path.dirname(artifactsDirectory);
  const taskPath = resolveProjectFile(root, path.relative(root, path.join(taskDirectory, "task.md")), "task.md");
  const fixPlanText = readFileSync(fixPlanPath, "utf8");
  const taskText = readFileSync(taskPath, "utf8");
  const sourceReview = section(fixPlanText, "Source Review", "Human Approval Gate");
  const reviewRelativePath = bullet(sourceReview, "Review");
  const expectedReviewSha256 = bullet(sourceReview, "Review SHA-256");
  const target = bullet(sourceReview, "Target");
  const snapshot = bullet(sourceReview, "Snapshot");
  const taskId = bullet(sourceReview, "Task");
  if (!SHA256.test(expectedReviewSha256)) {
    throw new Error(`review-fix source review hash is invalid in ${requestedPath}`);
  }

  const reviewPath = resolveProjectFile(root, reviewRelativePath, "review.md");
  if (path.dirname(reviewPath) !== artifactsDirectory) {
    throw new Error(`review-fix source review must be beside fix-plan.md: ${reviewRelativePath}`);
  }
  const reviewText = readFileSync(reviewPath, "utf8");
  const reviewSha256 = sha256(reviewText);
  if (reviewSha256 !== expectedReviewSha256) {
    throw new Error(`review-fix review.md hash mismatch: expected ${expectedReviewSha256}, got ${reviewSha256}`);
  }

  const reviewTarget = bullet(section(reviewText, "Confirmed Target", "Verdict"), "Target");
  const reviewSnapshot = bullet(section(reviewText, "Confirmed Target", "Verdict"), "Snapshot");
  if (target !== reviewTarget || snapshot !== reviewSnapshot) {
    throw new Error("review-fix target or snapshot differs between review.md and fix-plan.md");
  }

  const reviewFindings = parseReviewFindings(reviewText);
  const planFindings = parsePlanFindings(fixPlanText);
  compareFindingCoverage(reviewFindings, planFindings);
  const accepted = planFindings.filter((finding) => finding.disposition === "accepted");
  if (accepted.length === 0) {
    throw new Error(`review-fix requires at least one accepted finding in ${requestedPath}`);
  }

  const reviewEvidence = section(taskText, "Review Evidence");
  const taskReviewPath = bullet(reviewEvidence, "Review");
  const taskReviewSha256 = bullet(reviewEvidence, "Review SHA-256");
  const taskFixPlanPath = bullet(reviewEvidence, "Fix Plan");
  const publishedFixPlanSha256 = bullet(reviewEvidence, "Published Fix Plan SHA-256");
  const taskTarget = bullet(reviewEvidence, "Target");
  const taskSnapshot = bullet(reviewEvidence, "Snapshot");
  const taskFindingIds = csv(bullet(reviewEvidence, "Finding IDs"));
  const taskFrontmatterId = frontmatterValue(taskText, "id");
  if (taskFrontmatterId !== taskId) {
    throw new Error(`review-fix task id mismatch: plan=${taskId}, task.md=${taskFrontmatterId}`);
  }
  if (
    taskReviewPath !== posixRelative(root, reviewPath) ||
    taskReviewSha256 !== reviewSha256 ||
    taskFixPlanPath !== posixRelative(root, fixPlanPath) ||
    taskTarget !== target ||
    taskSnapshot !== snapshot
  ) {
    throw new Error("review-fix task.md evidence does not match review.md and fix-plan.md");
  }
  if (!SHA256.test(publishedFixPlanSha256)) {
    throw new Error("review-fix published fix-plan hash is invalid in task.md");
  }
  const reviewIds = reviewFindings.map((finding) => finding.id);
  if (!sameStringSet(taskFindingIds, reviewIds)) {
    throw new Error("review-fix task.md finding ids do not match review.md");
  }

  const fixPlanSha256 = sha256(fixPlanText);
  if (fixPlanSha256 === publishedFixPlanSha256) {
    throw new Error("review-fix plan still matches the all-pending published plan; no human approval edit is proven");
  }
  const headCommit = resolveSnapshotHead(root, snapshot);
  const fixReportPath = path.join(artifactsDirectory, "fix-report.md");

  return {
    projectRoot: root,
    taskId,
    taskPath,
    reviewPath,
    fixPlanPath,
    fixReportPath,
    target,
    snapshot,
    headCommit,
    reviewSha256,
    fixPlanSha256,
    publishedFixPlanSha256,
    findingIds: reviewIds,
    acceptedFindingIds: accepted.map((finding) => finding.id),
    ignoredFindingIds: planFindings
      .filter((finding) => finding.disposition !== "accepted")
      .map((finding) => finding.id),
    reviewText,
    fixPlanText,
  };
}

export function verifyApprovedReviewPlan(plan) {
  const reviewSha256 = sha256(readFileSync(plan.reviewPath, "utf8"));
  const fixPlanSha256 = sha256(readFileSync(plan.fixPlanPath, "utf8"));
  if (reviewSha256 !== plan.reviewSha256) {
    throw new Error(`review-fix review.md changed after approval validation: ${plan.reviewPath}`);
  }
  if (fixPlanSha256 !== plan.fixPlanSha256) {
    throw new Error(`review-fix fix-plan.md changed after approval validation: ${plan.fixPlanPath}`);
  }
}

function parseReviewFindings(text) {
  const body = section(text, "New Findings", "Previous Findings Reconciliation");
  const matches = [...body.matchAll(/^###\s+([A-Za-z0-9._-]+)\s+—\s+\[([A-Za-z0-9]+)\]\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const block = body.slice(match.index, matches[index + 1]?.index ?? body.length);
    return {
      id: match[1],
      title: match[3].trim(),
      severity: match[2],
      scope: bullet(block, "Scope"),
      category: bullet(block, "Category"),
      location: unquote(bullet(block, "Location")),
    };
  });
}

function parsePlanFindings(text) {
  const body = section(text, "Findings");
  const matches = [...body.matchAll(/^###\s+([A-Za-z0-9._-]+)\s+—\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const block = body.slice(match.index, matches[index + 1]?.index ?? body.length);
    const disposition = bullet(block, "Disposition");
    if (!DISPOSITIONS.has(disposition)) {
      throw new Error(`review-fix finding ${match[1]} has unknown disposition: ${disposition}`);
    }
    return {
      id: match[1],
      title: match[2].trim(),
      disposition,
      severity: bullet(block, "Severity"),
      scope: bullet(block, "Scope"),
      category: bullet(block, "Category"),
      location: unquote(bullet(block, "Location")),
    };
  });
}

function compareFindingCoverage(reviewFindings, planFindings) {
  const reviewById = uniqueById(reviewFindings, "review.md");
  const planById = uniqueById(planFindings, "fix-plan.md");
  if (!sameStringSet([...reviewById.keys()], [...planById.keys()])) {
    throw new Error("review-fix finding id coverage differs between review.md and fix-plan.md");
  }
  for (const [id, reviewed] of reviewById) {
    const planned = planById.get(id);
    if (
      planned.title !== reviewed.title ||
      planned.severity !== reviewed.severity ||
      planned.scope !== reviewed.scope ||
      planned.category !== reviewed.category ||
      planned.location !== reviewed.location
    ) {
      throw new Error(`review-fix finding ${id} identity differs between review.md and fix-plan.md`);
    }
  }
}

function uniqueById(findings, source) {
  const byId = new Map();
  for (const finding of findings) {
    if (byId.has(finding.id)) throw new Error(`review-fix duplicate finding id in ${source}: ${finding.id}`);
    byId.set(finding.id, finding);
  }
  return byId;
}

function resolveSnapshotHead(projectRoot, snapshot) {
  const match = /\bhead=([0-9a-f]{7,64})\b/i.exec(snapshot);
  if (match === null) {
    throw new Error("review-fix snapshot must contain an immutable head=<commit> value");
  }
  try {
    return execFileSync("git", ["-C", projectRoot, "rev-parse", "--verify", `${match[1]}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`review-fix reviewed head is not addressable: ${match[1]}: ${message}`);
  }
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

function section(text, heading, nextHeading) {
  const startMatch = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m").exec(text);
  if (startMatch === null) throw new Error(`review-fix required section is missing: ## ${heading}`);
  const start = startMatch.index + startMatch[0].length;
  if (nextHeading === undefined) return text.slice(start);
  const rest = text.slice(start);
  const endMatch = new RegExp(`^## ${escapeRegExp(nextHeading)}\\s*$`, "m").exec(rest);
  if (endMatch === null) throw new Error(`review-fix required section is missing: ## ${nextHeading}`);
  return rest.slice(0, endMatch.index);
}

function bullet(text, label) {
  const matches = [...text.matchAll(new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+?)\\s*$`, "gm"))];
  if (matches.length !== 1) {
    throw new Error(`review-fix expected exactly one "${label}" field, found ${matches.length}`);
  }
  return matches[0][1].trim();
}

function frontmatterValue(text, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (match === null) throw new Error("review-fix task.md frontmatter is missing");
  const value = new RegExp(`^${escapeRegExp(key)}:\\s*"?([^"\\r\\n]+)"?\\s*$`, "m").exec(match[1]);
  if (value === null) throw new Error(`review-fix task.md frontmatter.${key} is missing`);
  return value[1].trim();
}

function csv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unquote(value) {
  return value.replace(/^`|`$/g, "");
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
