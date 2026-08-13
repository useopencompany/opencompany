"use server";

import { revalidatePath } from "next/cache";
import type { GoatAttioProviderState } from "@/lib/integration-state";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

const ATTIO_CONNECT_FALLBACK =
  "Could not connect Attio. Make sure the key has object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, comment:read-write, note:read-write, and webhook:read-write, then try again.";

export type AttioConnectActionResult =
  | { ok: true; state: GoatAttioProviderState }
  | { ok: false; error: string };

export async function saveAttioApiKeyAction(apiKey: string): Promise<AttioConnectActionResult> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      ok: false,
      error: "This does not look like an Attio API key. Check it and try again.",
    };
  }
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].attio.$put({
      json: { apiKey },
    });
    if (!response.ok) {
      return { ok: false, error: await serverApiErrorMessage(response, ATTIO_CONNECT_FALLBACK) };
    }
    const data = (await response.json()).data as { state: GoatAttioProviderState };
    revalidatePath("/", "layout");
    return { ok: true, state: data.state };
  } catch (error) {
    console.error("[goat-attio] Failed to save Attio API key", error);
    return { ok: false, error: ATTIO_CONNECT_FALLBACK };
  }
}

// Attio disconnect removes the webhook Attio-side first (best effort — the
// key may already be revoked), then hard-deletes the integration like every
// other personal account. Both steps run inside the canonical API.
export async function disconnectAttioIntegrationAction(
  integrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await (await serverApiClient()).v1["integration-accounts"].attio[
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
