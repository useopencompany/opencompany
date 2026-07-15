"use server";

import { getDb } from "@opencompany/db/client";
import { goatBrainSources, goatIntegrations } from "@opencompany/db/goat-schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";

export type GoatIntegrationAccountUsage = {
  ok: true;
  // brain_sources rows fed by this account (across all brains).
  affectedBrainSourceCount: number;
};

// Pre-disconnect check so the UI can warn before removing an account that
// still feeds brains.
export async function getGoatIntegrationAccountUsageAction(
  integrationId: string,
): Promise<GoatIntegrationAccountUsage | { ok: false; error: string }> {
  const context = await currentGoatUser();
  const owned = await loadOwnPersonalIntegration(integrationId, context.user.workosUserId);
  if (!owned) return { ok: false, error: "Only the connection owner can manage this account." };
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::integer` })
    .from(goatBrainSources)
    .where(eq(goatBrainSources.integrationId, integrationId));
  return { ok: true, affectedBrainSourceCount: Number(row?.count ?? 0) };
}

// Hard-deletes a personal integration account. Credentials, synced resources,
// brain sources, and buffered events cascade away; already-ingested brain
// content stays (pointer/copy rule) and event claims survive via SET NULL.
export async function disconnectGoatIntegrationAccountAction(
  integrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentGoatUser();
  const owned = await loadOwnPersonalIntegration(integrationId, context.user.workosUserId);
  if (!owned) return { ok: false, error: "Only the connection owner can manage this account." };
  try {
    await getDb().delete(goatIntegrations).where(eq(goatIntegrations.id, integrationId));
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect this account.",
    };
  }
}

async function loadOwnPersonalIntegration(integrationId: string, userWorkosId: string) {
  const [row] = await getDb()
    .select({ id: goatIntegrations.id })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.id, integrationId),
        eq(goatIntegrations.userWorkosId, userWorkosId),
        isNull(goatIntegrations.workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}
