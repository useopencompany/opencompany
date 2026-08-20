import type { TaskScheduleReadModel, WorkflowDto } from "@opencompany/protocol";

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
      provider: "linear";
      event: "issue_enters_triage";
      integrationId: string;
      team: { id: string; name: string; key?: string; triageStateId: string };
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

export type WorkflowDetail = {
  id: string;
  slug: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  status: "draft" | "active";
  trigger: WorkflowTrigger;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowListItem = WorkflowDetail;
export type TaskScheduleView = TaskScheduleReadModel;

export type WorkflowCatalogItem = {
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
    id: workflow.slug,
    name: workflow.name,
    description: workflow.description,
  };
}
