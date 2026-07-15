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
  try {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::integer` })
      .from(goatBrainSources)
      .where(eq(goatBrainSources.integrationId, integrationId));
    return { ok: true, affectedBrainSourceCount: Number(row?.count ?? 0) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not check account usage.",
    };
  }
}

// Hard-deletes a personal integration account. Credentials, synced resources,
// brain sources, and buffered events cascade away; already-ingested brain
// content stays (pointer/copy rule) and event claims survive via SET NULL.
export async function disconnectGoatIntegrationAccountAction(
  integrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentGoatUser();
  try {
    // Claims are created when work is enqueued, before the ingest job reaches
    // a terminal state. Hard-deleting an integration cascades its source items
    // and jobs, so release claims whose matching brain job never succeeded;
    // otherwise another member's copy could be suppressed forever. Keep claims
    // backed by successful jobs so completed ingestion remains deduplicated.
    const result = await getDb().execute(sql`
      WITH owned_integration AS (
        SELECT integration.id
        FROM goat.integrations integration
        WHERE integration.id = ${integrationId}
          AND integration.user_workos_id = ${context.user.workosUserId}
          AND integration.workspace_id IS NULL
      ),
      source_items AS MATERIALIZED (
        SELECT source.id
        FROM goat.brain_source_items source
        JOIN owned_integration integration ON integration.id = source.integration_id
      ),
      released_claims AS (
        DELETE FROM goat.brain_source_event_claims claim
        USING source_items source
        WHERE claim.source_item_id = source.id
          AND NOT EXISTS (
            SELECT 1
            FROM goat.brain_ingest_jobs job
            WHERE job.source_item_id = source.id
              AND job.brain_ref = claim.brain_id
              AND job.status = 'succeeded'
          )
        RETURNING claim.id
      ),
      release_guard AS (
        SELECT count(*) AS released_count FROM released_claims
      ),
      deleted_integration AS (
        DELETE FROM goat.integrations integration
        USING owned_integration owned, release_guard
        WHERE integration.id = owned.id
        RETURNING integration.id
      )
      SELECT id FROM deleted_integration
    `);
    if (rowsFromExecute<{ id: string }>(result).length === 0) {
      return { ok: false, error: "Only the connection owner can manage this account." };
    }
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

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }
  return [];
}
