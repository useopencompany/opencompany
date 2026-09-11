/** Shared by browser reservations and server creation paths. Existing IDs stay opaque. */
export function newResourceId(
  resource:
    | "conversation"
    | "workspace"
    | "workflow"
    | "task_schedule"
    | "workflow_schedule_run"
    | "task_schedule_run"
    | "share"
    | "artifact"
    | "artifact_version",
) {
  return `${resource}_${crypto.randomUUID()}`;
}
