/**
 * extensions/workflows/run/run-read.ts — the ONE read-only door into workflow run
 * persistence for code outside `extensions/workflows/`.
 *
 * WHY THIS EXISTS
 *
 * Workflow root runs persist under `.locus-pi/runs/<storageRootRunId>/`, with
 * saved children and attempts below fixed nested directories. The journal
 * owner also owns the append sink and journal-to-live-row
 * projection, and the live-row retention bound. Two consumers outside this
 * extension only ever needed to READ a run — the agent drill's round submenu and
 * the loop's continuation source — yet both reached straight into that module and
 * so held a handle on its write side too. This file is the narrow surface those
 * consumers get instead: read operations and the types they return, nothing else.
 * No sink, no append, no retention, no live-row mutation. `check:layers` declares
 * the journal feature-internal to `extensions/workflows/` and names this file as
 * its only sanctioned exception, so the seam cannot decay back into direct access.
 *
 * WHAT IS IMPLEMENTED HERE, AND WHAT IS ONLY RE-EXPORTED
 *
 * Nothing is implemented here: every symbol below is a re-export, and that is the
 * evidenced choice rather than the lazy one. A read operation is worth relocating
 * only when it is self-contained; each of these is not, for one of two reasons.
 *
 *   - `workflowRunIdFromRowId` is a pure parse of a live-row id, but the journal's
 *     own retention pass calls it to work out which runs still own live rows, and
 *     then clears those runs' writer entries from the process-global
 *     `locus-pi.workflow-live-executions.v1` map the journal declares. Relocating
 *     it would make the journal import this file, i.e. make foundational code
 *     import a feature directory, which is the exact edge the ownership refactor
 *     exists to remove.
 *   - Path constructors belong to the layout owner and are not exposed here.
 *     This facade re-exports only resolved read operations allowed across feature layers.
 *   - `listWorkflowRunIds`, `readWorkflowRunSummary`, `listWorkflowRoundsForSlot`,
 *     `readWorkflowRoundBody`, and `readWorkflowSlotPhase` all resolve through
 *     private journal internals — the start-timestamp proof that orders runs, the
 *     per-line structural validator that separates valid rows from diagnostics,
 *     and the persisted-result disposition projection. Copying any of them here
 *     would fork a parser away from the format it parses.
 *
 * `readWorkflowRunSummary` includes the semantic `hasJournal` flag needed by outside
 * consumers. Raw journal records remain private to the workflow owner.
 */

export {
  listWorkflowRoundsForSlot,
  listWorkflowRootRunIds,
  listWorkflowRunIds,
  readWorkflowRoundBody,
  readWorkflowRunSummary,
  readWorkflowSlotPhase,
  resolveWorkflowRunId,
  workflowRunIdFromRowId,
} from "../runtime/workflow-journal.js";
export type { WorkflowRunSummary } from "../runtime/workflow-journal.js";
export {
  WORKFLOW_NESTED_RUN_STORAGE_PATTERN,
  WORKFLOW_RUN_GROUP_STORAGE_PATTERN,
  resolveWorkflowRunDir,
  workflowJournalFile,
  workflowRunsRootDir,
} from "../runtime/workflow-run-layout.js";
export { workflowResultFile } from "../runtime/workflow-result.js";
