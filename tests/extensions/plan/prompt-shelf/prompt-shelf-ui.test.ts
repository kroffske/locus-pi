import { describe, expect, it } from "vitest";
import { renderOperatorBlockPlain } from "../../../../extensions/_shared/operator/operator-ui.js";
import { parsePromptShelfCommand, type PromptShelfTarget } from "../../../../extensions/plan/command/command-parser.js";
import {
  promptShelfBodyBlock,
  promptShelfChangeBlock,
  promptShelfSummaryBlock,
  promptShelfWarningBlock,
} from "../../../../extensions/plan/prompt-shelf/prompt-shelf-ui.js";

const projectReviewTarget: PromptShelfTarget = {
  kind: "review",
  target: "project-local",
  path: "/repo/.locus/runtime/prompts/review.md",
  displayPath: "./.locus/runtime/prompts/review.md",
};

const taskReviewTarget: PromptShelfTarget = {
  kind: "review",
  target: "task:T-205",
  path: "/repo/.tasks/T-205-state-prompt-shelves/artifacts/review-prompt.md",
  displayPath: "/repo/.tasks/T-205-state-prompt-shelves/artifacts/review-prompt.md",
};

describe("prompt shelf parser", () => {
  it.each([
    ["", "project", "summary", undefined, undefined],
    ["show", "project", "show", undefined, undefined],
    ["read", "project", "show", undefined, undefined],
    ["set show", "project", "write", "show", "explicit"],
    ["set read", "project", "write", "read", "explicit"],
    ["show this wording", "project", "write", "show this wording", "legacy"],
    ["legacy prompt", "project", "write", "legacy prompt", "legacy"],
    ["--task T-205", "task", "summary", undefined, undefined],
    ["--task T-205 show", "task", "show", undefined, undefined],
    ["--task=T-205 set read", "task", "write", "read", "explicit"],
  ])("parses %j without losing compatibility", (input, targetType, actionKind, prompt, source) => {
    const parsed = parsePromptShelfCommand(input);
    expect(parsed.target.type).toBe(targetType);
    expect(parsed.action.kind).toBe(actionKind);
    if (parsed.action.kind === "write") {
      expect(parsed.action.prompt).toBe(prompt);
      expect(parsed.action.source).toBe(source);
    }
  });

  it.each(["set", "--task", "--task="])("fails closed for incomplete input %j", (input) => {
    const parsed = parsePromptShelfCommand(input);
    expect(parsed.action.kind).toBe("invalid");
  });
});

describe("prompt shelf blocks", () => {
  it("keeps a saved bare shelf summary-only", () => {
    const saved = "# review\n\nSecret body that must require explicit show.\n";
    const block = promptShelfSummaryBlock("review", projectReviewTarget, saved);
    const text = renderOperatorBlockPlain(block, 80).join("\n");
    expect(text).toContain("[VIEW] Review prompt shelf");
    expect(text).toContain("body is hidden");
    expect(text).toContain("Open body: /review show");
    expect(text).not.toContain("Secret body");
  });

  it("shows body only through the explicit body block", () => {
    const saved = "# review\n\nVisible only after show.\n";
    const text = renderOperatorBlockPlain(promptShelfBodyBlock("review", projectReviewTarget, saved), 80).join("\n");
    expect(text).toContain("[VIEW] Review prompt shelf body");
    expect(text).toContain("Visible only after show.");
    expect(text).toContain("path: ./.locus/runtime/prompts/review.md");
  });

  it("uses distinct canonical labels for empty goal and todos shelves", () => {
    const goal = { ...projectReviewTarget, kind: "goal" as const };
    const todos = { ...projectReviewTarget, kind: "todos" as const };
    expect(renderOperatorBlockPlain(promptShelfSummaryBlock("goal", goal, undefined), 80).join("\n")).toContain(
      "[WARN] Goal prompt shelf",
    );
    expect(renderOperatorBlockPlain(promptShelfSummaryBlock("todos", todos, undefined), 80).join("\n")).toContain(
      "[WARN] Todos prompt shelf",
    );
  });

  it("keeps the explicit task target in every recovery control", () => {
    const blocks = [
      promptShelfSummaryBlock("review", taskReviewTarget, "Saved task review"),
      promptShelfBodyBlock("review", taskReviewTarget, "Saved task review"),
      promptShelfChangeBlock("review", taskReviewTarget),
      promptShelfWarningBlock("review", "Task target was not found.", "task:T-205"),
    ];

    for (const block of blocks) {
      const controls = block.controls ?? [];
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((control) => control.includes("/review --task T-205"))).toBe(true);
    }
  });

  it("marks legacy writes and points to the scoped set spelling", () => {
    const block = promptShelfChangeBlock("review", taskReviewTarget, "legacy");
    const text = renderOperatorBlockPlain(block, 80).join("\n");
    expect(text).toContain("Review prompt saved. Deprecated:");
    expect(text).toContain("/review --task T-205 set <prompt>");

    const boundedText = renderOperatorBlockPlain(block, 80, { maxLines: 4 }).join("\n");
    expect(boundedText).toContain("Review prompt saved. Deprecated:");
    expect(boundedText).toContain("/review --task T-205 set <prompt>");
  });

  it("preserves type, target, and recovery action at 146/80/48 columns", () => {
    const blocks = [
      promptShelfChangeBlock("review", projectReviewTarget),
      promptShelfWarningBlock("review", "Task target was not found.", "task:T-404", ["No project fallback was used."]),
    ];
    for (const width of [146, 80, 48]) {
      for (const block of blocks) {
        const lines = renderOperatorBlockPlain(block, width);
        expect(lines.every((line) => line.length <= width)).toBe(true);
        expect(lines.join("\n")).toContain(`[${block.type}]`);
        expect(lines.join("\n")).toContain("Review prompt shelf");
        expect(lines.join("\n")).toContain("target:");
      }
    }
  });
});
