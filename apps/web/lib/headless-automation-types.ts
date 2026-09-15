import type {
  TaskScheduleReadModel,
  WorkflowDto,
  WorkflowScope,
  WorkflowSlackChannel,
} from "@opencompany/protocol";

export type WorkflowStep = {
  id: string;
  title: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  instructions: string;
};

export type WorkflowTrigger =
  | { type: "manual" }
  | {
      type: "event";
      provider: string;
      event: string;
      integrationId: string;
      filters: Record<
        string,
        { id: string; name: string; key?: string; metadata?: Record<string, string> }
      >;
      prompt: string;
    }
  | {
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
      lastRunAt: string | null;
      nextRunAt: string | null;
    };

export type WorkflowAutomationTrigger =
  | ({ id: string } & Extract<WorkflowTrigger, { type: "event" }>)
  | ({ id: string } & Extract<WorkflowTrigger, { type: "schedule" }>);

export type WorkflowDetail = {
  id: string;
  slug: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  status: "draft" | "active";
  scope: WorkflowScope;
  slackChannel: WorkflowSlackChannel;
  createdByUserId: string | null;
  trigger: WorkflowTrigger;
  triggers?: WorkflowAutomationTrigger[];
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowListItem = WorkflowDetail;

// The API only returns workflows the viewer may edit, so editability needs no client rule. Changing
// the visibility itself is narrower: the creator, or an admin claiming one that predates scopes.
export function canManageWorkflowScope(
  workflow: Pick<WorkflowDetail, "createdByUserId">,
  viewer: { userId: string; role: "admin" | "member" },
) {
  return (
    workflow.createdByUserId === viewer.userId ||
    (workflow.createdByUserId === null && viewer.role === "admin")
  );
}

export type TaskScheduleView = TaskScheduleReadModel;

export type WorkflowCatalogItem = {
  steps: WorkflowStep[];
  id: string;
  name: string;
  description: string;
};

export function workflowDtoToCatalogItem(workflow: WorkflowDto): WorkflowCatalogItem | null {
  if (
    workflow.status !== "active" ||
    workflow.steps.length === 0 ||
    (workflow.steps as WorkflowStep[]).some((step) => !step.instructions.trim())
  ) {
    return null;
  }
  return {
    steps: workflow.steps,
    id: workflow.slug,
    name: workflow.name,
    description: workflow.description,
  };
}
