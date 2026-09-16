"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export async function disconnectIntegrationAccountAction(
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
export async function setIntegrationCapabilityModeAction(
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

export async function setIntegrationToolModeAction(
  integrationId: string,
  toolId: string,
  mode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!integrationId || !toolId || !mode) {
    return { ok: false, error: "Unknown permission mode." };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"][":integrationId"][
      "tool-modes"
    ][":toolId"].$put({
      param: { integrationId, toolId },
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
export async function alwaysAllowChatActionAction(
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
