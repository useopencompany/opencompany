import type {
  GoatAnalyticsEventName,
  GoatAnalyticsEventProperties,
  GoatTaskSpawnKind,
  GoatTaskSpawnOrigin,
  GoatTaskSpawnTrigger,
} from "./goat-events";
import { type GoatAnalyticsPerson, goatAnalyticsPersonProperties } from "./goat-person";
import { capturePostHogServerEvent } from "./server-core";

export type CaptureGoatTaskSpawnedInput = {
  userWorkosId: string;
  workspaceId?: string | null;
  taskId: string;
  displayId?: string | null;
  engine: "opencompany" | "codex" | "claude_code";
  model: string;
  workflowId?: string | null;
  scheduleId?: string | null;
  trigger?: GoatTaskSpawnTrigger;
};

function getGoatPostHogConfig() {
  return {
    token: process.env.NEXT_PUBLIC_GOAT_POSTHOG_TOKEN,
    host: process.env.NEXT_PUBLIC_GOAT_POSTHOG_HOST,
    project: "goat" as const,
  };
}

export function captureGoatServerEvent<EventName extends GoatAnalyticsEventName>(
  event: EventName,
  distinctId: string,
  properties: GoatAnalyticsEventProperties<EventName>,
  person?: GoatAnalyticsPerson,
) {
  const personProperties = person ? goatAnalyticsPersonProperties(person) : undefined;

  return capturePostHogServerEvent(getGoatPostHogConfig(), {
    event,
    distinctId,
    properties: {
      ...properties,
      ...(personProperties && Object.keys(personProperties).length > 0
        ? { $set: personProperties }
        : {}),
    },
  });
}

export function captureGoatTaskSpawned(input: CaptureGoatTaskSpawnedInput) {
  const workflowId = normalizedOptional(input.workflowId);
  const scheduleId = normalizedOptional(input.scheduleId);
  const workspaceId = normalizedOptional(input.workspaceId);
  const displayId = normalizedOptional(input.displayId);
  const hasWorkflow = Boolean(workflowId);
  const trigger = input.trigger ?? "manual";
  const hasSchedule = Boolean(scheduleId || trigger === "schedule");
  const taskOrigin = goatTaskSpawnOrigin(hasWorkflow);
  const taskKind = goatTaskSpawnKind({ origin: taskOrigin, trigger });

  return captureGoatServerEvent(
    "task_spawned",
    input.userWorkosId,
    {
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      task_id: input.taskId,
      ...(displayId ? { display_id: displayId } : {}),
      task_kind: taskKind,
      task_origin: taskOrigin,
      task_trigger: trigger,
      engine: input.engine,
      model: input.model,
      has_workflow: hasWorkflow,
      has_schedule: hasSchedule,
      ...(workflowId ? { workflow_id: workflowId } : {}),
      ...(scheduleId ? { schedule_id: scheduleId } : {}),
    },
    workspaceId ? { workspaceId } : undefined,
  );
}

function goatTaskSpawnOrigin(hasWorkflow: boolean): GoatTaskSpawnOrigin {
  return hasWorkflow ? "workflow" : "adhoc";
}

function goatTaskSpawnKind(input: {
  origin: GoatTaskSpawnOrigin;
  trigger: GoatTaskSpawnTrigger;
}): GoatTaskSpawnKind {
  if (input.trigger === "schedule") {
    return input.origin === "workflow" ? "scheduled_workflow" : "scheduled_task";
  }
  return input.origin;
}

function normalizedOptional(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}
