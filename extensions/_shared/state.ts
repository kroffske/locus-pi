import type { AgentDefinition, PlanTask } from "./types.js";

export interface GoalState {
  objective: string;
  constraints: string[];
  doneCriteria: string[];
  openQuestions: string[];
  completed: boolean;
  updatedAt: string;
}

export const sharedState: {
  goal: GoalState | null;
  plan: { active: boolean; executionApproved: boolean; tasks: PlanTask[]; raw: string | null };
  todos: Array<{
    name: string;
    tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned"; notes?: string[] }>;
  }>;
  todoContext: string | null;
  todoAutoContinue: boolean;
  agents: Map<string, AgentDefinition>;
  toolPreset: string;
} = {
  goal: null,
  plan: { active: false, executionApproved: false, tasks: [], raw: null },
  todos: [],
  todoContext: null,
  todoAutoContinue: false,
  agents: new Map(),
  toolPreset: "minimal",
};

export function compactGoalContext(): string | null {
  const goal = sharedState.goal;
  if (!goal || goal.completed) return null;
  const lines = [`Current goal: ${goal.objective}`];
  if (goal.constraints.length) lines.push(`Constraints: ${goal.constraints.join("; ")}`);
  if (goal.doneCriteria.length) lines.push(`Done criteria: ${goal.doneCriteria.join("; ")}`);
  if (goal.openQuestions.length) lines.push(`Open questions: ${goal.openQuestions.join("; ")}`);
  return lines.join("\n").slice(0, 4000);
}
