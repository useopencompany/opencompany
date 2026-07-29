"use server";

import {
  GOAT_ATTIO_CREDENTIAL_KIND,
  GOAT_ATTIO_PROVIDER,
  type GoatAttioApiKeyCredentialPayload,
} from "@opencompany/db/goat-attio";
import { loadGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { disconnectGoatIntegrationAccountAction } from "@/lib/integration-account-actions";
import type { GoatAttioProviderState } from "@/lib/integration-state";
import {
  connectGoatAttioIntegration,
  deleteGoatAttioWebhook,
  getGoatAttioIntegrationState,
  hasGoatAttioListConfigurationWriteScope,
  hasGoatAttioListReadScopes,
  hasGoatAttioListWriteScopes,
  hasGoatAttioRecordWriteScopes,
  isValidAttioApiKey,
  validateGoatAttioApiKey,
} from "@/lib/integrations/attio";

export type AttioConnectActionResult =
  | { ok: true; state: GoatAttioProviderState }
  | { ok: false; error: string };

export async function saveAttioApiKeyAction(apiKey: string): Promise<AttioConnectActionResult> {
  const { user } = await currentGoatUser();
  const trimmed = apiKey.trim();
  if (!isValidAttioApiKey(trimmed)) {
    return {
      ok: false,
      error: "This does not look like an Attio API key. Check it and try again.",
    };
  }
  try {
    const validation = await validateGoatAttioApiKey(trimmed);
    if (!validation.ok) return { ok: false, error: validation.error };
    if (
      !hasGoatAttioListReadScopes(validation.identity.scopes) ||
      !hasGoatAttioListConfigurationWriteScope(validation.identity.scopes) ||
      !hasGoatAttioRecordWriteScopes(validation.identity.scopes) ||
      !hasGoatAttioListWriteScopes(validation.identity.scopes)
    ) {
      return {
        ok: false,
        error:
          "This Attio API key needs object_configuration:read, record_permission:read-write, list_configuration:read-write, and list_entry:read-write so Chat can read and operate CRM records, lists, and pipeline fields.",
      };
    }
    await connectGoatAttioIntegration({
      userWorkosId: user.workosUserId,
      apiKey: trimmed,
      identity: validation.identity,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getGoatAttioIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[goat-attio] Failed to save Attio API key", error);
    return {
      ok: false,
      error:
        "Could not connect Attio. Make sure the key has object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, note:read-write, and webhook:read-write, then try again.",
    };
  }
}

// Attio disconnect removes the webhook Attio-side first (best effort — the
// key may already be revoked), then hard-deletes the integration like every
// other personal account.
export async function disconnectAttioIntegrationAction(
  integrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { user } = await currentGoatUser();
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: user.workosUserId,
    integrationId,
    provider: GOAT_ATTIO_PROVIDER,
    kind: GOAT_ATTIO_CREDENTIAL_KIND,
  }).catch(() => null);
  const payload = credential?.payload as GoatAttioApiKeyCredentialPayload | undefined;
  if (payload?.apiKey && payload.webhookId) {
    await deleteGoatAttioWebhook({ apiKey: payload.apiKey, webhookId: payload.webhookId });
  }
  return await disconnectGoatIntegrationAccountAction(integrationId);
}
