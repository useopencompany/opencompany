"use server";

import { isValidBrainId } from "@opencompany/brain";
import type { HarnessSpec, WorkflowStep } from "@opencompany/db/schema";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { SkillMentionError } from "@/lib/skills";
import { prepareWorkflowRunForUser } from "@/lib/workflow-tasks";
import {
  archiveWorkflow,
  createWorkflow,
  DEFAULT_WORKFLOW_SCHEDULE_PROMPT,
  updateWorkflow,
  validateWorkflowFields,
  WorkflowMentionError,
  type WorkflowMutationResult,
  type WorkflowTriggerInput,
} from "@/lib/workflows";

// Workflows are workspace-public for now: every member can author the shared
// automation catalog, and every member can invoke it.
async function requireWorkspaceMember(): Promise<
  { ok: false; message: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentUser({ optional: true });
  if (!context) return { ok: false, message: "You must be signed in." };
  return { ok: true, workspaceId: context.workspace.id, userWorkosId: context.user.workosUserId };
}

export async function createWorkflowAction(input: {
  name: string;
  description?: string;
}): Promise<WorkflowMutationResult> {
  if (
    !input ||
    typeof input.name !== "string" ||
    (input.description !== undefined && typeof input.description !== "string")
  ) {
    return { ok: false, message: "Invalid workflow details." };
  }
  const gate = await requireWorkspaceMember();
  if (!gate.ok) return gate;
  const result = await createWorkflow({
    workspaceId: gate.workspaceId,
    createdByWorkosId: gate.userWorkosId,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (result.ok) revalidatePath("/workflows");
  return result;
}

export async function updateWorkflowAction(input: {
  slug: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  status: "draft" | "active";
  trigger?: WorkflowTriggerInput;
}): Promise<WorkflowMutationResult> {
  if (
    !input ||
    !isValidBrainId(input.slug) ||
    typeof input.name !== "string" ||
    typeof input.description !== "string" ||
    !Array.isArray(input.steps) ||
    !input.steps.every(isWorkflowStep) ||
    (input.status !== "draft" && input.status !== "active") ||
    !isWorkflowTriggerInput(input.trigger)
  ) {
    return { ok: false, message: "Invalid workflow details." };
  }
  const gate = await requireWorkspaceMember();
  if (!gate.ok) return gate;

  const invalid = validateWorkflowFields(input);
  if (invalid) return { ok: false, message: invalid };

  let scheduleHarnessSpec: HarnessSpec | null = null;
  if (input.trigger?.type === "schedule" && input.status === "active") {
    if (input.steps.length === 0 || input.steps.some((step) => !step.instructions.trim())) {
      return { ok: false, message: "Scheduled workflows need instructions in every step." };
    }
    try {
      const prepared = await prepareWorkflowRunForUser({
        userWorkosId: gate.userWorkosId,
        workspaceId: gate.workspaceId,
        workflow: {
          id: input.slug,
          name: input.name,
          description: input.description,
          steps: input.steps,
        },
        description: input.trigger.prompt?.trim() || DEFAULT_WORKFLOW_SCHEDULE_PROMPT,
      });
      scheduleHarnessSpec = prepared.harnessSpec;
    } catch (error) {
      if (error instanceof WorkflowMentionError || error instanceof SkillMentionError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  const result = await updateWorkflow({
    workspaceId: gate.workspaceId,
    ...input,
    scheduleHarnessSpec,
    scheduleUserWorkosId: input.trigger?.type === "schedule" ? gate.userWorkosId : null,
  });
  if (result.ok) {
    revalidatePath("/workflows");
    revalidatePath(`/workflows/${input.slug}`);
  }
  return result;
}

function isWorkflowStep(value: unknown): value is WorkflowStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.id === "string" &&
    typeof step.title === "string" &&
    typeof step.model === "string" &&
    typeof step.instructions === "string"
  );
}

function isWorkflowTriggerInput(value: unknown): value is WorkflowTriggerInput | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trigger = value as Record<string, unknown>;
  if (trigger.type === "manual") return true;
  return (
    trigger.type === "schedule" &&
    typeof trigger.cron === "string" &&
    (trigger.timezone === undefined ||
      trigger.timezone === null ||
      typeof trigger.timezone === "string") &&
    (trigger.prompt === undefined || trigger.prompt === null || typeof trigger.prompt === "string")
  );
}

export async function archiveWorkflowAction(input: {
  slug: string;
}): Promise<WorkflowMutationResult> {
  if (!input || !isValidBrainId(input.slug)) {
    return { ok: false, message: "Invalid workflow." };
  }
  const gate = await requireWorkspaceMember();
  if (!gate.ok) return gate;
  const result = await archiveWorkflow({ workspaceId: gate.workspaceId, slug: input.slug });
  if (result.ok) revalidatePath("/workflows");
  return result;
}
