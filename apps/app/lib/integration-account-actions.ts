"use server";

import { getDb } from "@opencompany/db/client";
import { brainSources, integrations } from "@opencompany/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  type CapabilityMode,
  isCapabilityId,
  isCapabilityMode,
  providerCapability,
} from "@/lib/actions/capabilities";
import { resolveActionCatalog } from "@/lib/actions/catalog";
import { currentUser } from "@/lib/auth";

export type IntegrationAccountUsage = {
  ok: true;
  // brain_sources rows fed by this account (across all brains).
  affectedBrainSourceCount: number;
};

// Pre-disconnect check so the UI can warn before removing an account that
// still feeds brains.
export async function getIntegrationAccountUsageAction(
  integrationId: string,
): Promise<IntegrationAccountUsage | { ok: false; error: string }> {
  const context = await currentUser();
  const owned = await loadOwnPersonalIntegration(integrationId, context.user.workosUserId);
  if (!owned) return { ok: false, error: "Only the connection owner can manage this account." };
  try {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::integer` })
      .from(brainSources)
      .where(eq(brainSources.integrationId, integrationId));
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
export async function disconnectIntegrationAccountAction(
  integrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentUser();
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

// Settings control: one capability mode ("on" | "ask" | "off") for one
// connection. Modes are stored as sparse overrides; registry defaults cover
// missing keys.
export async function setIntegrationCapabilityModeAction(
  integrationId: string,
  capabilityId: string,
  mode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentUser();
  if (!isCapabilityMode(mode) || !isCapabilityId(capabilityId)) {
    return { ok: false, error: "Unknown permission mode." };
  }
  const owned = await loadOwnPersonalIntegration(integrationId, context.user.workosUserId);
  if (!owned) return { ok: false, error: "Only the connection owner can manage this account." };
  const [row] = await getDb()
    .select({ provider: integrations.provider })
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);
  const capability = row ? providerCapability(row.provider, capabilityId) : undefined;
  if (!capability) {
    return { ok: false, error: "This integration has no such permission." };
  }
  try {
    await applyCapabilityMode([integrationId], capabilityId, mode);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the permission.",
    };
  }
}

// Chat "Always allow": flips the asked capability to "on" for every ask-mode
// connection behind the action, so the next call runs without a confirmation.
// The catalog is re-resolved server-side — the client only names the action.
export async function alwaysAllowChatActionAction(
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentUser();
  try {
    const catalog = await resolveActionCatalog({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
    });
    const action = catalog.actions.find((entry) => entry.id === actionId);
    const permission = action?.permission;
    if (!permission || permission.integrationIds.length === 0) {
      // Nothing to flip (already on, or the action disappeared) — not an error
      // worth surfacing over the one-off approval that is about to run.
      return { ok: true };
    }
    await applyCapabilityMode(permission.integrationIds, permission.capabilityId, "on");
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the permission.",
    };
  }
}

async function applyCapabilityMode(
  integrationIds: string[],
  capabilityId: string,
  mode: CapabilityMode,
) {
  await getDb()
    .update(integrations)
    .set({
      capabilityModes: sql`${integrations.capabilityModes} || ${JSON.stringify({
        [capabilityId]: mode,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(inArray(integrations.id, integrationIds));
}

async function loadOwnPersonalIntegration(integrationId: string, userWorkosId: string) {
  const [row] = await getDb()
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.id, integrationId),
        eq(integrations.userWorkosId, userWorkosId),
        isNull(integrations.workspaceId),
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
