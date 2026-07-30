import { describe, expect, it } from "vitest";
import type { GoalOperationResult, GoalState } from "../../../extensions/_shared/project/goal-mode.js";
import { renderOperatorBlockPlain } from "../../../extensions/_shared/operator/operator-ui.js";
import {
  emptyGoalStateBlock,
  goalErrorBlock,
  goalOperationBlock,
  goalStateBlock,
} from "../../../extensions/plan/goal-operator-ui.js";

const state: GoalState = {
  version: 1,
  goal: {
    id: "goal-1",
    objective: "Make the operator UI unambiguous",
    status: "active",
    tokenBudget: 5000,
    tokensUsed: 120,
    timeUsedSeconds: 42,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z",
    activeSince: "2026-07-10T00:00:00.000Z",
  },
};

describe("goal operator blocks", () => {
  it("labels runtime goal state without prompt-shelf ambiguity", () => {
    const text = renderOperatorBlockPlain(goalStateBlock(state), 80).join("\n");
    expect(text).toContain("[VIEW] Goal state");
    expect(text).toContain("Make the operator UI unambiguous");
    expect(text).toContain("status: active");
    expect(text).toContain("Prompt shelf: /goal prompt");
    expect(text).not.toContain("Goal prompt shelf body");
  });

  it("uses one recovery action for empty state", () => {
    const text = renderOperatorBlockPlain(emptyGoalStateBlock(), 80).join("\n");
    expect(text).toContain("[WARN] Goal state");
    expect(text).toContain("No active goal.");
    expect(text).toContain("Create: /goal set <objective>");
  });

  it.each(["active", "paused", "budget-limited", "complete", "dropped"] as const)(
    "preserves the %s lifecycle state as text, not color alone",
    (status) => {
      const next: GoalState = { ...state, goal: { ...state.goal, status } };
      for (const width of [146, 80, 48]) {
        const text = renderOperatorBlockPlain(goalStateBlock(next), width).join("\n");
        expect(text).toContain("[VIEW] Goal state");
        expect(text).toContain(`status: ${status}`);
        if (width >= 60) expect(text).toContain(status.toUpperCase());
      }
    },
  );

  it("renders lifecycle changes and no-op transitions differently", () => {
    const changed = goalOperationBlock({ state, changed: true, message: "Goal resumed." }, "/repo");
    const noChange = goalOperationBlock({ state, changed: false, message: "Goal is already active." }, "/repo");
    expect(renderOperatorBlockPlain(changed, 80).join("\n")).toContain("[CHANGE] Goal state");
    expect(renderOperatorBlockPlain(changed, 80).join("\n")).toContain("objective: Make the operator UI unambiguous");
    expect(renderOperatorBlockPlain(noChange, 80).join("\n")).toContain("[WARN] Goal state");
  });

  it("shows continuation metadata but omits its prompt body", () => {
    const result: GoalOperationResult = {
      state,
      changed: false,
      message: "Goal continuation saved.",
      continuation: {
        version: 1,
        goalId: "goal-1",
        objective: state.goal.objective,
        path: "/repo/.locus/runtime/goal/continue.md",
        prompt: "SECRET CONTINUATION BODY",
        autoDispatch: false,
        status: "manual",
        stopReason: "bounded",
        createdAt: "2026-07-10T00:02:00.000Z",
        maxSteps: 1,
      },
    };
    const text = renderOperatorBlockPlain(goalOperationBlock(result, "/repo"), 80).join("\n");
    expect(text).toContain("[CHANGE] Goal continuation");
    expect(text).toContain("path: ./.locus/runtime/goal/continue.md");
    expect(text).toContain("autoDispatch: false");
    expect(text).not.toContain("SECRET CONTINUATION BODY");
  });

  it("preserves typed failure meaning at 146/80/48 columns", () => {
    for (const width of [146, 80, 48]) {
      const lines = renderOperatorBlockPlain(goalErrorBlock(new Error("storage unavailable")), width);
      expect(lines.join("\n")).toContain("[ERROR] Goal state");
      expect(lines.join("\n")).toContain("storage unavailable");
      expect(lines.every((line) => line.length <= width)).toBe(true);
    }
  });
});
