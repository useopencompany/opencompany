"use server";

import type { AttioProviderState } from "@opencompany/core/integration-state";
import {
  connectAttioIntegration,
  deleteAttioWebhook,
  getAttioIntegrationState,
  hasAttioCommentWriteScopes,
  hasAttioListConfigurationWriteScope,
  hasAttioListReadScopes,
  hasAttioListWriteScopes,
  hasAttioRecordWriteScopes,
  isValidAttioApiKey,
  validateAttioApiKey,
} from "@opencompany/core/integrations/attio";
import {
  ATTIO_CREDENTIAL_KIND,
  ATTIO_PROVIDER,
  type AttioApiKeyCredentialPayload,
} from "@opencompany/db/attio";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { disconnectIntegrationAccountAction } from "@/lib/integration-account-actions";

export type AttioConnectActionResult =
  | { ok: true; state: AttioProviderState }
  | { ok: false; error: string };

export async function saveAttioApiKeyAction(apiKey: string): Promise<AttioConnectActionResult> {
  const { user } = await currentUser();
  const trimmed = apiKey.trim();
  if (!isValidAttioApiKey(trimmed)) {
    return {
      ok: false,
      error: "This does not look like an Attio API key. Check it and try again.",
    };
  }
  try {
    const validation = await validateAttioApiKey(trimmed);
    if (!validation.ok) return { ok: false, error: validation.error };
    if (
      !hasAttioListReadScopes(validation.identity.scopes) ||
      !hasAttioListConfigurationWriteScope(validation.identity.scopes) ||
      !hasAttioRecordWriteScopes(validation.identity.scopes) ||
      !hasAttioListWriteScopes(validation.identity.scopes) ||
      !hasAttioCommentWriteScopes(validation.identity.scopes)
    ) {
      return {
        ok: false,
        error:
          "This Attio API key needs object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, and comment:read-write so Chat can read and operate CRM records, lists, pipeline fields, and comments.",
      };
    }
    await connectAttioIntegration({
      userWorkosId: user.workosUserId,
      apiKey: trimmed,
      identity: validation.identity,
    });
    revalidatePath("/", "layout");
    return { ok: true, state: await getAttioIntegrationState(user.workosUserId) };
  } catch (error) {
    console.error("[attio] Failed to save Attio API key", error);
    return {
      ok: false,
      error:
        "Could not connect Attio. Make sure the key has object_configuration:read, record_permission:read-write, list_configuration:read-write, list_entry:read-write, comment:read-write, note:read-write, and webhook:read-write, then try again.",
    };
  }
}

// Attio disconnect removes the webhook Attio-side first (best effort — the
// key may already be revoked), then hard-deletes the integration like every
// other personal account.
export async function disconnectAttioIntegrationAction(
  integrationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { user } = await currentUser();
  const credential = await loadIntegrationCredential({
    userWorkosId: user.workosUserId,
    integrationId,
    provider: ATTIO_PROVIDER,
    kind: ATTIO_CREDENTIAL_KIND,
  }).catch(() => null);
  const payload = credential?.payload as AttioApiKeyCredentialPayload | undefined;
  if (payload?.apiKey && payload.webhookId) {
    await deleteAttioWebhook({ apiKey: payload.apiKey, webhookId: payload.webhookId });
  }
  return await disconnectIntegrationAccountAction(integrationId);
}
