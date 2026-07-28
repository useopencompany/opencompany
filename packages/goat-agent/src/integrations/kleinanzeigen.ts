import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
  saveGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { captureGoatIntegrationAddedAnalytics } from "./analytics";

export const GOAT_KLEINANZEIGEN_PROVIDER = "kleinanzeigen" as const;
export const GOAT_KLEINANZEIGEN_EXTERNAL_ID = "browser_use_kleinanzeigen";
export const GOAT_BROWSER_USE_API_V2_BASE_URL = "https://api.browser-use.com/api/v2";
export const GOAT_BROWSER_USE_API_V3_BASE_URL = "https://api.browser-use.com/api/v3";
export const GOAT_KLEINANZEIGEN_MAX_SESSION_COST_USD = 0.75;
const GOAT_BROWSER_USE_TIMEOUT_MS = 15_000;
const GOAT_KLEINANZEIGEN_CREDENTIAL_KIND = "api_key" as const;

export type GoatKleinanzeigenCredentialPayload = {
  apiKey: string;
  projectId: string;
  profileId: string;
  browserWorkspaceId: string;
  connectedAt: string;
};

export type GoatKleinanzeigenConnection = GoatKleinanzeigenCredentialPayload & {
  integrationId: string;
  userWorkosId: string;
  accountName: string;
  capabilityModes: Record<string, unknown>;
};

export type GoatBrowserUseIdentity = {
  projectId: string;
  accountName: string;
  planName: string | null;
  creditsBalanceUsd: number;
};

export type GoatBrowserUseSession = {
  id: string;
  status: "created" | "idle" | "running" | "stopped" | "timed_out" | "error";
  liveUrl: string | null;
  output: unknown;
  isTaskSuccessful: boolean | null;
  profileId: string | null;
  workspaceId: string | null;
  lastStepSummary: string | null;
  totalCostUsd: string | number | null;
};

export type GoatBrowserUseUploadedFile = {
  name: string;
  path: string;
};

type BrowserUseErrorPayload = {
  detail?: unknown;
  message?: unknown;
};

export class GoatBrowserUseApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: string | undefined;

  constructor(status: number, path: string, payload?: BrowserUseErrorPayload | null) {
    super(`Browser Use API ${path} failed (${status}).`);
    this.name = "GoatBrowserUseApiError";
    this.status = status;
    this.path = path;
    this.detail = browserUseErrorDetail(payload);
  }
}

export function isValidGoatBrowserUseApiKey(value: string) {
  return value.length >= 20 && value.length <= 500 && !/\s/.test(value);
}

export async function validateGoatBrowserUseApiKey(
  apiKey: string,
): Promise<{ ok: true; identity: GoatBrowserUseIdentity } | { ok: false; error: string }> {
  if (!isValidGoatBrowserUseApiKey(apiKey)) {
    return { ok: false, error: "Enter a valid Browser Use API key." };
  }
  try {
    const account = await requestGoatBrowserUseApi<{
      projectId?: unknown;
      name?: unknown;
      totalCreditsBalanceUsd?: unknown;
      planInfo?: { planName?: unknown } | null;
    }>({
      apiKey,
      version: "v2",
      path: "/billing/account",
      signal: AbortSignal.timeout(GOAT_BROWSER_USE_TIMEOUT_MS),
    });
    if (typeof account.projectId !== "string" || !account.projectId) {
      return { ok: false, error: "Browser Use did not return a valid project for this key." };
    }
    return {
      ok: true,
      identity: {
        projectId: account.projectId,
        accountName: cleanLabel(account.name) ?? "Browser Use",
        planName: cleanLabel(account.planInfo?.planName),
        creditsBalanceUsd:
          typeof account.totalCreditsBalanceUsd === "number" &&
          Number.isFinite(account.totalCreditsBalanceUsd)
            ? account.totalCreditsBalanceUsd
            : 0,
      },
    };
  } catch (error) {
    if (error instanceof GoatBrowserUseApiError && (error.status === 401 || error.status === 403)) {
      return { ok: false, error: "Browser Use rejected this API key. Check it and try again." };
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, error: "Browser Use took too long to respond. Try again in a moment." };
    }
    return { ok: false, error: "Could not reach Browser Use. Try again in a moment." };
  }
}

export async function provisionGoatKleinanzeigenBrowserUse(input: {
  apiKey: string;
  userWorkosId: string;
}): Promise<{ profileId: string; browserWorkspaceId: string }> {
  const profile = await requestGoatBrowserUseApi<{ id: string }>({
    apiKey: input.apiKey,
    version: "v3",
    path: "/profiles",
    method: "POST",
    body: {
      name: "OpenCompany · Kleinanzeigen",
      userId: createHash("sha256").update(input.userWorkosId).digest("hex"),
    },
  });
  let workspace: { id: string };
  try {
    workspace = await requestGoatBrowserUseApi<{ id: string }>({
      apiKey: input.apiKey,
      version: "v3",
      path: "/workspaces",
      method: "POST",
      body: { name: "OpenCompany · Kleinanzeigen images" },
    });
  } catch (error) {
    if (isUuid(profile.id)) {
      await requestGoatBrowserUseApi<void>({
        apiKey: input.apiKey,
        version: "v3",
        path: `/profiles/${encodeURIComponent(profile.id)}`,
        method: "DELETE",
      }).catch(() => undefined);
    }
    throw error;
  }
  if (!isUuid(profile.id) || !isUuid(workspace.id)) {
    await Promise.allSettled([
      ...(isUuid(profile.id)
        ? [
            requestGoatBrowserUseApi<void>({
              apiKey: input.apiKey,
              version: "v3",
              path: `/profiles/${encodeURIComponent(profile.id)}`,
              method: "DELETE",
            }),
          ]
        : []),
      ...(isUuid(workspace.id)
        ? [
            requestGoatBrowserUseApi<void>({
              apiKey: input.apiKey,
              version: "v3",
              path: `/workspaces/${encodeURIComponent(workspace.id)}`,
              method: "DELETE",
            }),
          ]
        : []),
    ]);
    throw new Error("Browser Use did not provision a valid profile and workspace.");
  }
  return { profileId: profile.id, browserWorkspaceId: workspace.id };
}

export async function connectGoatKleinanzeigenIntegration(input: {
  apiKey: string;
  userWorkosId: string;
  identity: GoatBrowserUseIdentity;
  profileId: string;
  browserWorkspaceId: string;
  now?: Date;
}): Promise<{ integrationId: string }> {
  const db = getDb();
  const now = input.now ?? new Date();
  const [integration] = await db
    .insert(goatIntegrations)
    .values({
      id: newGoatKleinanzeigenIntegrationId(),
      userWorkosId: input.userWorkosId,
      provider: GOAT_KLEINANZEIGEN_PROVIDER,
      externalId: GOAT_KLEINANZEIGEN_EXTERNAL_ID,
      connectionLabel: "Kleinanzeigen",
      accountName: input.identity.accountName,
      accountType: "browser_use_api_key",
      status: "connected",
      statusReason: null,
      scopes: [],
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        goatIntegrations.userWorkosId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      targetWhere: sql`${goatIntegrations.workspaceId} IS NULL`,
      set: {
        connectionLabel: "Kleinanzeigen",
        accountName: input.identity.accountName,
        accountType: "browser_use_api_key",
        status: "connected",
        statusReason: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: goatIntegrations.id });
  if (!integration) throw new Error("Could not persist the Kleinanzeigen integration.");

  try {
    await saveGoatIntegrationCredential({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_KLEINANZEIGEN_PROVIDER,
      kind: GOAT_KLEINANZEIGEN_CREDENTIAL_KIND,
      payload: {
        apiKey: input.apiKey,
        projectId: input.identity.projectId,
        profileId: input.profileId,
        browserWorkspaceId: input.browserWorkspaceId,
        connectedAt: now.toISOString(),
      } satisfies GoatKleinanzeigenCredentialPayload,
      expiresAt: null,
      db,
      now,
    });
  } catch (error) {
    await markGoatIntegrationStatus({
      userWorkosId: input.userWorkosId,
      integrationId: integration.id,
      provider: GOAT_KLEINANZEIGEN_PROVIDER,
      status: "sync_failed",
      statusReason: "Failed to persist Browser Use credentials.",
      db,
      now: new Date(),
    });
    throw error;
  }
  await captureGoatIntegrationAddedAnalytics({
    userWorkosId: input.userWorkosId,
    provider: GOAT_KLEINANZEIGEN_PROVIDER,
  });
  return { integrationId: integration.id };
}

export async function loadGoatKleinanzeigenConnection(
  userWorkosId: string,
): Promise<GoatKleinanzeigenConnection | null> {
  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      userWorkosId: goatIntegrations.userWorkosId,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
      capabilityModes: goatIntegrations.capabilityModes,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        isNull(goatIntegrations.workspaceId),
        eq(goatIntegrations.provider, GOAT_KLEINANZEIGEN_PROVIDER),
        eq(goatIntegrations.externalId, GOAT_KLEINANZEIGEN_EXTERNAL_ID),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);
  if (!integration || integration.status !== "connected") return null;

  const credential = await loadGoatIntegrationCredential({
    userWorkosId,
    integrationId: integration.id,
    provider: GOAT_KLEINANZEIGEN_PROVIDER,
    kind: GOAT_KLEINANZEIGEN_CREDENTIAL_KIND,
  });
  const payload = parseGoatKleinanzeigenCredential(credential?.payload);
  if (!payload) return null;
  return {
    integrationId: integration.id,
    userWorkosId,
    accountName: integration.accountName?.trim() || "Browser Use",
    capabilityModes: integration.capabilityModes ?? {},
    ...payload,
  };
}

export async function disconnectGoatKleinanzeigenIntegration(userWorkosId: string) {
  const connection = await loadGoatKleinanzeigenConnection(userWorkosId);
  if (connection) await cleanupGoatKleinanzeigenBrowserUseResources(connection);
  const deleted = await getDb()
    .delete(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.userWorkosId, userWorkosId),
        isNull(goatIntegrations.workspaceId),
        eq(goatIntegrations.provider, GOAT_KLEINANZEIGEN_PROVIDER),
        eq(goatIntegrations.externalId, GOAT_KLEINANZEIGEN_EXTERNAL_ID),
      ),
    )
    .returning({ id: goatIntegrations.id });
  return deleted.length > 0;
}

export async function cleanupGoatKleinanzeigenBrowserUseResources(
  connection: Pick<GoatKleinanzeigenConnection, "apiKey" | "browserWorkspaceId" | "profileId">,
) {
  await Promise.allSettled([
    requestGoatBrowserUseApi<void>({
      apiKey: connection.apiKey,
      version: "v3",
      path: `/workspaces/${encodeURIComponent(connection.browserWorkspaceId)}`,
      method: "DELETE",
    }),
    requestGoatBrowserUseApi<void>({
      apiKey: connection.apiKey,
      version: "v3",
      path: `/profiles/${encodeURIComponent(connection.profileId)}`,
      method: "DELETE",
    }),
  ]);
}

export async function markGoatKleinanzeigenConnectionNeedsReauth(
  connection: GoatKleinanzeigenConnection,
) {
  await markGoatIntegrationStatus({
    userWorkosId: connection.userWorkosId,
    integrationId: connection.integrationId,
    provider: GOAT_KLEINANZEIGEN_PROVIDER,
    status: "needs_reauth",
    statusReason: "Browser Use rejected the saved API key. Reconnect it in Settings.",
  });
}

export async function startGoatKleinanzeigenLoginSession(
  connection: GoatKleinanzeigenConnection,
  signal?: AbortSignal,
): Promise<{ sessionId: string; liveUrl: string }> {
  const session = await requestGoatBrowserUseApi<{ id?: unknown; liveUrl?: unknown }>({
    apiKey: connection.apiKey,
    version: "v3",
    path: "/browsers",
    method: "POST",
    body: {
      profileId: connection.profileId,
      proxyCountryCode: "de",
      timeout: 10,
      browserScreenWidth: 1440,
      browserScreenHeight: 1000,
      allowResizing: true,
      enableRecording: false,
    },
    ...(signal ? { signal } : {}),
  });
  if (typeof session.id !== "string" || typeof session.liveUrl !== "string") {
    throw new Error("Browser Use did not return a live login session.");
  }
  const liveUrl = safeBrowserUseLiveUrl(session.liveUrl);
  if (!liveUrl) throw new Error("Browser Use returned an invalid live session URL.");
  return { sessionId: session.id, liveUrl };
}

export async function stopGoatKleinanzeigenLoginSession(
  connection: GoatKleinanzeigenConnection,
  sessionId: string,
  signal?: AbortSignal,
) {
  if (!isUuid(sessionId)) throw new Error("Invalid Browser Use session id.");
  await requestGoatBrowserUseApi({
    apiKey: connection.apiKey,
    version: "v3",
    path: `/browsers/${encodeURIComponent(sessionId)}`,
    method: "PATCH",
    body: { action: "stop" },
    ...(signal ? { signal } : {}),
  });
}

export async function uploadGoatKleinanzeigenWorkspaceFiles(input: {
  connection: GoatKleinanzeigenConnection;
  prefix: string;
  files: Array<{ filename: string; mediaType: string; bytes: Uint8Array }>;
  signal?: AbortSignal;
}): Promise<GoatBrowserUseUploadedFile[]> {
  const prefix = safeWorkspacePrefix(input.prefix);
  const files = input.files.map((file, index) => ({
    name: `${String(index + 1).padStart(2, "0")}-${safeFilename(file.filename)}`,
    contentType: file.mediaType,
    size: file.bytes.byteLength,
  }));
  const response = await requestGoatBrowserUseApi<{
    files?: Array<{ name?: unknown; uploadUrl?: unknown; path?: unknown }>;
  }>({
    apiKey: input.connection.apiKey,
    version: "v3",
    path: `/workspaces/${encodeURIComponent(input.connection.browserWorkspaceId)}/files/upload`,
    method: "POST",
    query: { prefix },
    body: { files },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!Array.isArray(response.files) || response.files.length !== input.files.length) {
    throw new Error("Browser Use did not prepare every image upload.");
  }

  const uploadResults = await Promise.allSettled(
    response.files.map(async (target, index) => {
      if (
        typeof target.name !== "string" ||
        typeof target.path !== "string" ||
        typeof target.uploadUrl !== "string"
      ) {
        throw new Error("Browser Use returned an invalid image upload target.");
      }
      const uploadUrl = new URL(target.uploadUrl);
      if (uploadUrl.protocol !== "https:") {
        throw new Error("Browser Use returned an insecure image upload target.");
      }
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": input.files[index]!.mediaType },
        body: Buffer.from(input.files[index]!.bytes),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!upload.ok) throw new Error(`Could not upload image ${index + 1} to Browser Use.`);
      return { name: target.name, path: target.path };
    }),
  );
  const uploaded = uploadResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failed = uploadResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    await deleteGoatKleinanzeigenWorkspaceFiles(
      input.connection,
      uploaded.map((file) => file.path),
    );
    throw failed.reason;
  }
  return uploaded;
}

export async function createGoatBrowserUseAgentSession(input: {
  connection: GoatKleinanzeigenConnection;
  task: string;
  outputSchema: Record<string, unknown>;
  existingSessionId?: string;
  keepAlive: boolean;
  signal?: AbortSignal;
}): Promise<GoatBrowserUseSession> {
  const session = await requestGoatBrowserUseApi<GoatBrowserUseSession>({
    apiKey: input.connection.apiKey,
    version: "v3",
    path: "/sessions",
    method: "POST",
    body: {
      task: input.task,
      model: "claude-sonnet-4.6",
      ...(input.existingSessionId ? { sessionId: input.existingSessionId } : {}),
      keepAlive: input.keepAlive,
      maxCostUsd: GOAT_KLEINANZEIGEN_MAX_SESSION_COST_USD,
      ...(!input.existingSessionId
        ? {
            profileId: input.connection.profileId,
            workspaceId: input.connection.browserWorkspaceId,
            proxyCountryCode: "de",
          }
        : {}),
      outputSchema: input.outputSchema,
      enableScheduledTasks: false,
      enableRecording: false,
      skills: false,
      agentmail: false,
      cacheScript: false,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return normalizeBrowserUseSession(session);
}

export async function getGoatBrowserUseAgentSession(
  connection: GoatKleinanzeigenConnection,
  sessionId: string,
  signal?: AbortSignal,
): Promise<GoatBrowserUseSession> {
  if (!isUuid(sessionId)) throw new Error("Invalid Browser Use session id.");
  const session = await requestGoatBrowserUseApi<GoatBrowserUseSession>({
    apiKey: connection.apiKey,
    version: "v3",
    path: `/sessions/${encodeURIComponent(sessionId)}`,
    ...(signal ? { signal } : {}),
  });
  return normalizeBrowserUseSession(session);
}

export async function stopGoatBrowserUseAgentSession(
  connection: GoatKleinanzeigenConnection,
  sessionId: string,
) {
  if (!isUuid(sessionId)) return;
  await requestGoatBrowserUseApi<void>({
    apiKey: connection.apiKey,
    version: "v3",
    path: `/sessions/${encodeURIComponent(sessionId)}/stop`,
    method: "POST",
  });
}

export async function deleteGoatKleinanzeigenWorkspaceFiles(
  connection: GoatKleinanzeigenConnection,
  paths: readonly string[],
) {
  await Promise.allSettled(
    paths.map((path) =>
      requestGoatBrowserUseApi<void>({
        apiKey: connection.apiKey,
        version: "v3",
        path: `/workspaces/${encodeURIComponent(connection.browserWorkspaceId)}/files`,
        method: "DELETE",
        query: { path },
      }),
    ),
  );
}

export async function requestGoatBrowserUseApi<T = unknown>(input: {
  apiKey: string;
  version: "v2" | "v3";
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const baseUrl =
    input.version === "v3" ? GOAT_BROWSER_USE_API_V3_BASE_URL : GOAT_BROWSER_USE_API_V2_BASE_URL;
  const url = new URL(`${baseUrl}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const timeoutSignal = AbortSignal.timeout(GOAT_BROWSER_USE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        "X-Browser-Use-API-Key": input.apiKey,
        Accept: "application/json",
        ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      signal,
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw error;
    }
    throw new Error("Could not reach Browser Use.");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as BrowserUseErrorPayload | null;
    throw new GoatBrowserUseApiError(response.status, input.path, payload);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function safeBrowserUseLiveUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "browser-use.com" && !url.hostname.endsWith(".browser-use.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function safeKleinanzeigenListingUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "kleinanzeigen.de" && !url.hostname.endsWith(".kleinanzeigen.de"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeBrowserUseSession(session: GoatBrowserUseSession): GoatBrowserUseSession {
  if (!isUuid(session.id)) throw new Error("Browser Use returned an invalid session.");
  return {
    ...session,
    liveUrl: safeBrowserUseLiveUrl(session.liveUrl),
    profileId: typeof session.profileId === "string" ? session.profileId : null,
    workspaceId: typeof session.workspaceId === "string" ? session.workspaceId : null,
    lastStepSummary:
      typeof session.lastStepSummary === "string"
        ? session.lastStepSummary.replace(/\s+/g, " ").trim().slice(0, 500)
        : null,
  };
}

function parseGoatKleinanzeigenCredential(
  value: unknown,
): GoatKleinanzeigenCredentialPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.apiKey !== "string" ||
    !isValidGoatBrowserUseApiKey(payload.apiKey) ||
    typeof payload.projectId !== "string" ||
    !isUuid(payload.profileId) ||
    !isUuid(payload.browserWorkspaceId) ||
    typeof payload.connectedAt !== "string"
  ) {
    return null;
  }
  return {
    apiKey: payload.apiKey,
    projectId: payload.projectId,
    profileId: payload.profileId,
    browserWorkspaceId: payload.browserWorkspaceId,
    connectedAt: payload.connectedAt,
  };
}

function safeWorkspacePrefix(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^\/+|\/+$/g, "");
  return `${normalized.slice(0, 100) || "listings"}/`;
}

function safeFilename(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "");
  return (normalized || "image.jpg").slice(-120);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function browserUseErrorDetail(payload: BrowserUseErrorPayload | null | undefined) {
  const detail =
    typeof payload?.message === "string"
      ? payload.message
      : typeof payload?.detail === "string"
        ? payload.detail
        : null;
  return detail ? detail.replace(/\s+/g, " ").trim().slice(0, 500) : undefined;
}

function newGoatKleinanzeigenIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "")}`;
}
