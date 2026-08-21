/** Canonical ordered root menu data for the `/workflows` command. */
const WORKFLOW_MENU_DESCRIPTIONS = {
  dashboard: "inspect persisted runs and evidence",
  list: "browse available workflows",
  info: "inspect one workflow's details",
  status: "view recent run progress",
  result: "read a finished run's output",
  run: "start a workflow",
  continue: "answer a pending handoff",
  stop: "stop an active run",
  skills: "install workflow skills for external agents",
} as const;

export type WorkflowMenuCommand = keyof typeof WORKFLOW_MENU_DESCRIPTIONS;

export const WORKFLOW_MENU_OPTIONS = (Object.keys(WORKFLOW_MENU_DESCRIPTIONS) as WorkflowMenuCommand[]).map(
  (command) => ({ command, label: `${command} — ${WORKFLOW_MENU_DESCRIPTIONS[command]}` }),
);
