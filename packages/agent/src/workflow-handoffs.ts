import type { HarnessSpec } from "@opencompany/db/product-schema";

// Every run started by another run is one level deeper than its starter. Two workflows that
// mention each other would otherwise start each other forever, each run spending real money.
// Three levels covers "build → review → fix" while keeping a runaway chain small and visible.
export const MAX_WORKFLOW_HANDOFF_DEPTH = 3;

export type WorkflowHandoffGrant = {
  /** Slugs of the workflows the current step's instructions mention, never the run's own. */
  workflowIds: string[];
  /** How many handoffs led to this run: zero for a run a person, schedule, or event started. */
  depth: number;
};

/**
 * The workflows a Task run may start right now: the ones its current step mentions as
 * `@workflow/<slug>`. Null when the run may start none, which is also the answer for every
 * non-workflow Task and for a run already at the bottom of a handoff chain.
 */
export function workflowHandoffGrant(
  harnessSpec: Pick<HarnessSpec, "workflow"> | null | undefined,
): WorkflowHandoffGrant | null {
  const workflow = harnessSpec?.workflow;
  if (!workflow?.steps) return null;
  const depth = workflow.handoffDepth ?? 0;
  if (depth >= MAX_WORKFLOW_HANDOFF_DEPTH) return null;
  const step = workflow.steps[workflow.currentStepIndex ?? 0];
  const workflowIds = (step?.handoffWorkflowIds ?? []).filter((id) => id !== workflow.id);
  return workflowIds.length ? { workflowIds, depth } : null;
}
