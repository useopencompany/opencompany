"use server";

import {
  MANAGED_CAPABILITY_SOURCES,
  setCapabilitySessionBudget,
  setWorkspaceCapability,
} from "@opencompany/db/capabilities";
import type { ManagedCapabilitySource } from "@opencompany/db/schema";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";

export async function setWorkspaceCapabilityAction(input: {
  source: ManagedCapabilitySource;
  enabled: boolean;
}) {
  const context = await currentUser();
  if (context.role !== "admin") {
    return {
      ok: false as const,
      error: "Only workspace admins can change paid capabilities.",
    };
  }
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    !MANAGED_CAPABILITY_SOURCES.includes(input.source)
  ) {
    return { ok: false as const, error: "Invalid capability setting." };
  }
  const row = await setWorkspaceCapability({
    workspaceId: context.workspace.id,
    source: input.source,
    enabled: input.enabled,
    updatedByWorkosId: context.user.workosUserId,
  });
  revalidatePath("/settings/workspace/capabilities");
  return { ok: true as const, source: row.source, enabled: row.enabled };
}

export async function setWorkspaceCapabilitySessionBudgetAction(input: {
  budgetUsd: number | null;
}) {
  const context = await currentUser();
  if (context.role !== "admin") {
    return {
      ok: false as const,
      error: "Only workspace admins can change the per-chat spending limit.",
    };
  }
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
  const budgetUsdMicros =
    input.budgetUsd === null ? null : Math.max(1, Math.round(input.budgetUsd * 1_000_000));
  const effectiveBudgetUsdMicros = await setCapabilitySessionBudget({
    workspaceId: context.workspace.id,
    budgetUsdMicros,
  });
  revalidatePath("/settings/workspace/capabilities");
  return { ok: true as const, budgetUsdMicros: effectiveBudgetUsdMicros };
}
