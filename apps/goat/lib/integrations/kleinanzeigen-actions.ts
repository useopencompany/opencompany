"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import type { GoatIntegrationAccountView } from "@/lib/integration-state";
import {
  cleanupGoatKleinanzeigenBrowserUseResources,
  connectGoatKleinanzeigenIntegration,
  disconnectGoatKleinanzeigenIntegration,
  GoatBrowserUseApiError,
  isValidGoatBrowserUseApiKey,
  loadGoatKleinanzeigenConnection,
  markGoatKleinanzeigenConnectionNeedsReauth,
  provisionGoatKleinanzeigenBrowserUse,
  startGoatKleinanzeigenLoginSession,
  stopGoatKleinanzeigenLoginSession,
  validateGoatBrowserUseApiKey,
} from "@/lib/integrations/kleinanzeigen";

export type KleinanzeigenConnectActionResult =
  | { ok: true; account: GoatIntegrationAccountView }
  | { ok: false; error: string };

export async function saveKleinanzeigenBrowserUseApiKeyAction(
  apiKey: string,
): Promise<KleinanzeigenConnectActionResult> {
  const context = await currentGoatUser();
  if (typeof apiKey !== "string" || !isValidGoatBrowserUseApiKey(apiKey.trim())) {
    return { ok: false, error: "Enter a valid Browser Use API key." };
  }
  const trimmed = apiKey.trim();
  const previous = await loadGoatKleinanzeigenConnection(context.user.workosUserId);
  let provisioned: { profileId: string; browserWorkspaceId: string } | null = null;
  let persisted = false;
  try {
    const validation = await validateGoatBrowserUseApiKey(trimmed);
    if (!validation.ok) return validation;
    provisioned = await provisionGoatKleinanzeigenBrowserUse({
      apiKey: trimmed,
      userWorkosId: context.user.workosUserId,
    });
    const connectionResult = await connectGoatKleinanzeigenIntegration({
      apiKey: trimmed,
      userWorkosId: context.user.workosUserId,
      identity: validation.identity,
      ...provisioned,
    });
    persisted = true;
    if (previous) {
      await cleanupGoatKleinanzeigenBrowserUseResources(previous);
    }
    revalidatePath("/", "layout");
    return {
      ok: true,
      account: {
        integrationId: connectionResult.integrationId,
        provider: "kleinanzeigen",
        status: "connected",
        connected: true,
        accountEmail: null,
        accountName: validation.identity.accountName,
        connectionLabel: "Kleinanzeigen",
        statusReason: null,
        scopes: [],
        capabilityModes: previous?.capabilityModes ?? {},
      },
    };
  } catch (error) {
    if (provisioned && !persisted) {
      await cleanupGoatKleinanzeigenBrowserUseResources({
        apiKey: trimmed,
        ...provisioned,
      });
    }
    console.error("[goat-kleinanzeigen] Failed to connect Browser Use", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      error: browserUseActionError(
        error,
        "Could not connect Browser Use. Check the key and retry.",
      ),
    };
  }
}

export async function startKleinanzeigenLoginAction(): Promise<
  { ok: true; sessionId: string; liveUrl: string } | { ok: false; error: string }
> {
  const context = await currentGoatUser();
  const connection = await loadGoatKleinanzeigenConnection(context.user.workosUserId);
  if (!connection) return { ok: false, error: "Connect Browser Use first." };
  try {
    return {
      ok: true,
      ...(await startGoatKleinanzeigenLoginSession(connection)),
    };
  } catch (error) {
    if (isBrowserUseAuthError(error)) {
      await markGoatKleinanzeigenConnectionNeedsReauth(connection).catch(() => undefined);
    }
    return {
      ok: false,
      error: browserUseActionError(error, "Could not open the login browser. Try again."),
    };
  }
}

export async function stopKleinanzeigenLoginAction(
  sessionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentGoatUser();
  const connection = await loadGoatKleinanzeigenConnection(context.user.workosUserId);
  if (!connection) return { ok: false, error: "Kleinanzeigen is not connected." };
  try {
    await stopGoatKleinanzeigenLoginSession(connection, sessionId);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: browserUseActionError(error, "Could not stop the login browser. It will time out."),
    };
  }
}

export async function disconnectKleinanzeigenAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const context = await currentGoatUser();
  try {
    const disconnected = await disconnectGoatKleinanzeigenIntegration(context.user.workosUserId);
    if (!disconnected) return { ok: false, error: "Kleinanzeigen is not connected." };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect Kleinanzeigen.",
    };
  }
}

function isBrowserUseAuthError(error: unknown) {
  return error instanceof GoatBrowserUseApiError && (error.status === 401 || error.status === 403);
}

function browserUseActionError(error: unknown, fallback: string) {
  if (error instanceof GoatBrowserUseApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Browser Use rejected the saved API key. Reconnect and try again.";
    }
    if (error.status === 402) {
      return "This Browser Use project needs credits before it can start a browser.";
    }
    if (error.status === 429) return "Browser Use is at its session limit. Try again shortly.";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "Browser Use took too long to respond. Try again.";
  }
  return fallback;
}
