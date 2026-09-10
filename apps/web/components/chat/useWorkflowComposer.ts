"use client";

import { modelSupportsAttachments } from "@opencompany/agent-runtime";
import { useState } from "react";
import type { WorkflowCatalogItem, WorkflowStep } from "@/lib/headless-automation-types";
import { resolveWorkflowStepModelSelection } from "@/lib/workflow-model-options";

type Overrides = Pick<WorkflowStep, "id" | "model" | "runtimeModel" | "reasoningEffort">[];

export function useWorkflowComposer(workflow: WorkflowCatalogItem | null) {
  const [draft, setDraft] = useState<{ workflowId: string | null; overrides: Overrides }>({
    workflowId: null,
    overrides: [],
  });
  const workflowId = workflow?.id ?? null;
  if (draft.workflowId !== workflowId) setDraft({ workflowId, overrides: [] });
  const overrides = draft.workflowId === workflowId ? draft.overrides : [];
  const steps = (workflow?.steps ?? []).map((step) => {
    const override = overrides.find((override) => override.id === step.id);
    if (!override) return step;
    return { title: step.title, instructions: step.instructions, ...override };
  });
  let error: string | null = null;
  let requiresCredits = false;
  let capabilities = { images: true, pdf: true };
  try {
    for (const step of steps) {
      const selection = resolveWorkflowStepModelSelection(step);
      if (selection.engine !== "opencompany") continue;
      requiresCredits = true;
      const supported = modelSupportsAttachments(selection.model);
      capabilities = {
        images: capabilities.images && supported.images,
        pdf: capabilities.pdf && supported.pdf,
      };
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not resolve workflow models.";
    capabilities = { images: false, pdf: false };
  }
  return {
    steps,
    overrides,
    error,
    requiresCredits,
    capabilities,
    attachmentError: (attachments: readonly { kind: string }[]) => {
      if (attachments.some((attachment) => attachment.kind === "image") && !capabilities.images)
        return "One of this workflow’s selected models can't read images. Choose an image-capable model for this run.";
      if (attachments.some((attachment) => attachment.kind === "pdf") && !capabilities.pdf)
        return "One of this workflow’s selected models can't read PDFs. Choose a PDF-capable model for this run.";
      return null;
    },
    restore: () => setDraft({ workflowId, overrides }),
    reset: () => setDraft({ workflowId, overrides: [] }),
    update: (
      step: Omit<WorkflowStep, "runtimeModel" | "reasoningEffort"> & {
        runtimeModel?: string | undefined;
        reasoningEffort?: string | undefined;
      },
    ) => {
      const override = {
        id: step.id,
        model: step.model,
        ...(step.runtimeModel ? { runtimeModel: step.runtimeModel } : {}),
        ...(step.reasoningEffort ? { reasoningEffort: step.reasoningEffort } : {}),
      };
      setDraft({
        workflowId,
        overrides: [...overrides.filter((item) => item.id !== step.id), override],
      });
    },
  };
}
