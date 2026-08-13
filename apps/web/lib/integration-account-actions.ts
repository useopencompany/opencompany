"use server";

import { getDb } from "@opencompany/db/client";
import { applyGoatIntegrationCapabilityMode } from "@opencompany/db/goat-integrations";
import { revalidatePath } from "next/cache";
import { resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { currentGoatUser } from "@/lib/auth";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

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
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      ":integrationId"
    ].usage.$get({ param: { integrationId } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not check account usage."),
      };
    }
    const data = (await response.json()).data as { affectedBrainSourceCount: number };
    return { ok: true, affectedBrainSourceCount: data.affectedBrainSourceCount };
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
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][
      ":integrationId"
    ].$delete({ param: { integrationId } });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not disconnect this account."),
      };
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
// missing keys. Vocabulary and ownership validation happen in the API.
export async function setGoatIntegrationCapabilityModeAction(
  integrationId: string,
  capabilityId: string,
  mode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!integrationId || !capabilityId || !mode) {
    return { ok: false, error: "Unknown permission mode." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][":integrationId"][
      "capability-modes"
    ][":capabilityId"].$put({
      param: { integrationId, capabilityId },
      json: { mode },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not update the permission."),
      };
    }
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
//
// TEMPORARY web-owned adapter (#1203 5a2): the action catalog resolvers reach
// the db through getDb() internally, so re-resolving the catalog inside the
// canonical API would violate its injectable-db boundary. This one command
// stays here until the catalog resolvers take an injected handle; the
// capability write itself already goes through the shared db-package helper.
export async function alwaysAllowGoatChatActionAction(
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentGoatUser();
  try {
    const catalog = await resolveGoatActionCatalog({
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
    await applyGoatIntegrationCapabilityMode({
      integrationIds: permission.integrationIds,
      capabilityId: permission.capabilityId,
      mode: "on",
      db: getDb(),
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update the permission.",
    };
  }
}
