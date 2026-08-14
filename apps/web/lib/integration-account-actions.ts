"use server";

import { revalidatePath } from "next/cache";
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

// Chat "Always allow": the execution owner re-resolves the action catalog and
// flips every ask-mode connection behind the action to "on". The browser only
// sends the opaque action id from the approval card.
export async function alwaysAllowGoatChatActionAction(
  actionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await (await serverApiClient()).v1.actions[":actionId"].permissions[
      "always-allow"
    ].$post({
      param: { actionId },
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
