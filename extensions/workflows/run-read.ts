/**
 * extensions/workflows/run-read.ts — the ONE read-only door into workflow run
 * persistence for code outside `extensions/workflows/`.
 *
 * WHY THIS EXISTS
 *
 * Workflow runs persist under `.pi/locus-pi/workflows/<runId>/`, and the module
 * that owns that layout also owns the append sink, the journal-to-live-row
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
 *   - `workflowRunDir` is pure path derivation, and the ownership reason for leaving
 *     it in the journal has lapsed: the handoff, runner and replay modules that
 *     build run paths with it were in `extensions/_shared/` when this file was
 *     written, so relocating it here would have given each of them an upward edge
 *     into a feature directory. They now live beside the journal in
 *     `extensions/workflows/runtime/`, so that edge would be an ordinary
 *     same-extension import. What still argues against moving it is cohesion, not
 *     legality: the journal defines the run directory layout and calls the
 *     derivation at seven of its own call sites, and four further modules in this
 *     extension take it from the journal rather than from here. Moving it into the
 *     read door would put the layout definition in the facade and leave its owner
 *     importing its own contract back.
 *   - `listWorkflowRunIds`, `readWorkflowRunJournal`, `readWorkflowRunSummary`,
 *     `listWorkflowRoundsForSlot`, and `readWorkflowRoundBody` all resolve through
 *     private journal internals — the start-timestamp proof that orders runs, the
 *     per-line structural validator that separates valid rows from diagnostics,
 *     and the persisted-result disposition projection. Copying any of them here
 *     would fork a parser away from the format it parses.
 *
 * `readWorkflowRunJournal` returns lines typed in `workflow-runtime.ts`, not in the
 * journal, and no outside consumer names that type — they count lines. Re-exporting
 * it would widen this surface past what anything needs, so it is left out.
 */

export {
  listWorkflowRoundsForSlot,
  listWorkflowRunIds,
  readWorkflowRoundBody,
  readWorkflowRunJournal,
  readWorkflowRunSummary,
  workflowRunDir,
  workflowRunIdFromRowId,
} from "./runtime/workflow-journal.js";
export type { WorkflowRunSummary } from "./runtime/workflow-journal.js";
