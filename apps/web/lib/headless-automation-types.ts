import type { TaskScheduleReadModel, WorkflowDto } from "@opencompany/protocol";

export type GoatWorkflowStep = {
  id: string;
  title: string;
  model: string;
  runtimeModel?: string;
  reasoningEffort?: string;
  instructions: string;
};

export type GoatWorkflowTrigger =
  | { type: "manual" }
  | {
      type: "schedule";
      cron: string;
      timezone: string;
      prompt: string;
      enabled: boolean;
      lastRunAt: string | null;
      nextRunAt: string | null;
    };

export type GoatWorkflowDetail = {
  id: string;
  slug: string;
  name: string;
  description: string;
  steps: GoatWorkflowStep[];
  status: "draft" | "active";
  trigger: GoatWorkflowTrigger;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoatWorkflowListItem = GoatWorkflowDetail;
export type GoatTaskScheduleView = TaskScheduleReadModel;

export type GoatWorkflowCatalogItem = {
  id: string;
  name: string;
  description: string;
};

export function workflowDtoToCatalogItem(workflow: WorkflowDto): GoatWorkflowCatalogItem | null {
  if (
    workflow.status !== "active" ||
    workflow.steps.length === 0 ||
    (workflow.steps as GoatWorkflowStep[]).some((step) => !step.instructions.trim())
  ) {
    return null;
  }
  return {
    id: workflow.slug,
    name: workflow.name,
    description: workflow.description,
  };
}
