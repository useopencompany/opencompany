"use server";

import type { GoatHarnessSpec, GoatWorkflowStep } from "@opencompany/db/goat-schema";
import { isValidGoatBrainId } from "@opencompany/goat-brain";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { GoatSkillMentionError } from "@/lib/skills";
import { prepareGoatWorkflowRunForUser } from "@/lib/workflow-tasks";
import {
  archiveGoatWorkflow,
  createGoatWorkflow,
  DEFAULT_GOAT_WORKFLOW_SCHEDULE_PROMPT,
  GoatWorkflowMentionError,
  type GoatWorkflowMutationResult,
  type GoatWorkflowTriggerInput,
  updateGoatWorkflow,
  validateGoatWorkflowFields,
} from "@/lib/workflows";

// Authoring workflows is a workspace-admin mutation, mirroring the old
// Brain-folder authoring gate (manual content was admin-only).
async function requireWorkspaceAdmin(): Promise<
  { ok: false; message: string } | { ok: true; workspaceId: string; userWorkosId: string }
> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return { ok: false, message: "You must be signed in." };
  if (context.role !== "admin") {
    return { ok: false, message: "Only workspace admins can edit workflows." };
  }
  return { ok: true, workspaceId: context.workspace.id, userWorkosId: context.user.workosUserId };
}

export async function createGoatWorkflowAction(input: {
  name: string;
  description?: string;
}): Promise<GoatWorkflowMutationResult> {
  if (
    !input ||
    typeof input.name !== "string" ||
    (input.description !== undefined && typeof input.description !== "string")
  ) {
    return { ok: false, message: "Invalid workflow details." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await createGoatWorkflow({
    workspaceId: gate.workspaceId,
    createdByWorkosId: gate.userWorkosId,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  if (result.ok) revalidatePath("/workflows");
  return result;
}

export async function updateGoatWorkflowAction(input: {
  slug: string;
  name: string;
  description: string;
  steps: GoatWorkflowStep[];
  status: "draft" | "active";
  trigger?: GoatWorkflowTriggerInput;
}): Promise<GoatWorkflowMutationResult> {
  if (
    !input ||
    !isValidGoatBrainId(input.slug) ||
    typeof input.name !== "string" ||
    typeof input.description !== "string" ||
    !Array.isArray(input.steps) ||
    !input.steps.every(isGoatWorkflowStep) ||
    (input.status !== "draft" && input.status !== "active") ||
    !isGoatWorkflowTriggerInput(input.trigger)
  ) {
    return { ok: false, message: "Invalid workflow details." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;

  const invalid = validateGoatWorkflowFields(input);
  if (invalid) return { ok: false, message: invalid };

  let scheduleHarnessSpec: GoatHarnessSpec | null = null;
  if (input.trigger?.type === "schedule" && input.status === "active") {
    if (input.steps.length === 0 || input.steps.some((step) => !step.instructions.trim())) {
      return { ok: false, message: "Scheduled workflows need instructions in every step." };
    }
    try {
      const prepared = await prepareGoatWorkflowRunForUser({
        userWorkosId: gate.userWorkosId,
        workspaceId: gate.workspaceId,
        workflow: {
          id: input.slug,
          name: input.name,
          description: input.description,
          steps: input.steps,
        },
        description: input.trigger.prompt?.trim() || DEFAULT_GOAT_WORKFLOW_SCHEDULE_PROMPT,
      });
      scheduleHarnessSpec = prepared.harnessSpec;
    } catch (error) {
      if (error instanceof GoatWorkflowMentionError || error instanceof GoatSkillMentionError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  const result = await updateGoatWorkflow({
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

function isGoatWorkflowStep(value: unknown): value is GoatWorkflowStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.id === "string" &&
    typeof step.title === "string" &&
    typeof step.model === "string" &&
    typeof step.instructions === "string"
  );
}

function isGoatWorkflowTriggerInput(value: unknown): value is GoatWorkflowTriggerInput | undefined {
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

export async function archiveGoatWorkflowAction(input: {
  slug: string;
}): Promise<GoatWorkflowMutationResult> {
  if (!input || !isValidGoatBrainId(input.slug)) {
    return { ok: false, message: "Invalid workflow." };
  }
  const gate = await requireWorkspaceAdmin();
  if (!gate.ok) return gate;
  const result = await archiveGoatWorkflow({ workspaceId: gate.workspaceId, slug: input.slug });
  if (result.ok) revalidatePath("/workflows");
  return result;
}
