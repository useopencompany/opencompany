"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type ManagedCapabilitySource =
  | "x"
  | "linkedin"
  | "youtube"
  | "instagram"
  | "tiktok"
  | "lead"
  | "seo"
  | "image";

export type WorkspaceCapabilityState = {
  source: ManagedCapabilitySource;
  enabled: boolean;
};

export async function getWorkspaceCapabilitySettingsAction(): Promise<{
  capabilities: WorkspaceCapabilityState[];
  sessionBudgetUsdMicros: number;
}> {
  const response = await (await serverApiClient()).v1.capabilities.$get();
  if (!response.ok) throw new Error("Workspace capabilities could not be loaded.");
  return (await response.json()).data;
}

export async function setWorkspaceCapabilityAction(input: {
  source: ManagedCapabilitySource;
  enabled: boolean;
}) {
  if (!input || typeof input.enabled !== "boolean" || !isManagedCapabilitySource(input.source)) {
    return { ok: false as const, error: "Invalid capability setting." };
  }
  try {
    const response = await (await serverApiClient()).v1.capabilities[":source"].$put({
      param: { source: input.source },
      json: { enabled: input.enabled },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not update the capability."),
      };
    }
    const data = (await response.json()).data;
    revalidatePath("/settings/workspace/capabilities");
    return { ok: true as const, source: data.source, enabled: data.enabled };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not update the capability.",
    };
  }
}

export async function setWorkspaceCapabilitySessionBudgetAction(input: {
  budgetUsd: number | null;
}) {
  if (
    !input ||
    (input.budgetUsd !== null &&
      (typeof input.budgetUsd !== "number" ||
        !Number.isFinite(input.budgetUsd) ||
        input.budgetUsd <= 0 ||
        input.budgetUsd > 1_000))
  ) {
    return { ok: false as const, error: "Enter a spending limit between $0.01 and $1,000." };
  }
  try {
    const response = await (await serverApiClient()).v1.capabilities["session-budget"].$put({
      json: { budgetUsd: input.budgetUsd },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(
          response,
          "Could not update the per-chat spending limit.",
        ),
      };
    }
    const data = (await response.json()).data;
    revalidatePath("/settings/workspace/capabilities");
    return { ok: true as const, budgetUsdMicros: data.sessionBudgetUsdMicros };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof Error ? error.message : "Could not update the per-chat spending limit.",
    };
  }
}

function isManagedCapabilitySource(value: unknown): value is ManagedCapabilitySource {
  return ["x", "linkedin", "youtube", "instagram", "tiktok", "lead", "seo", "image"].includes(
    value as ManagedCapabilitySource,
  );
}
