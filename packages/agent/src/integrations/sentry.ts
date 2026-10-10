import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { SentryConnection } from "@opencompany/db/sentry";
import { createLogger } from "@opencompany/observability";
import { z } from "zod";
import { ActionAuthError } from "../actions/types";
import {
  ExpiringOAuthReauthRequired,
  getExpiringOAuthAccessToken,
} from "./expiring-oauth-access-token";

export const SENTRY_SCOPES = [
  "org:read",
  "project:read",
  "event:read",
  "event:write",
  "member:read",
  "team:read",
] as const;
export const SentryProjectSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    slug: z.string().min(1),
    name: z.string(),
    organization: z.object({ id: z.string().optional(), slug: z.string() }).optional(),
  })
  .passthrough();
export const SentryIssueSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    project: z.object({ id: z.string().regex(/^\d+$/), slug: z.string() }).passthrough(),
    title: z.string(),
    priority: z.string().optional(),
    issueCategory: z.string().optional(),
    firstSeen: z.string().optional(),
  })
  .passthrough();
export const SentryOccurrenceSchema = z
  .object({
    eventID: z.string().optional(),
    event_id: z.string().optional(),
    id: z.string().optional(),
    dateCreated: z.string().optional(),
    datetime: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    tags: z
      .array(
        z.union([
          z.object({ key: z.string(), value: z.string() }),
          z.tuple([z.string(), z.string()]),
        ]),
      )
      .optional(),
    environment: z.string().nullable().optional(),
  })
  .passthrough();
export type SentryIssue = z.infer<typeof SentryIssueSchema>;
export type SentryOccurrence = z.infer<typeof SentryOccurrenceSchema>;
export const SentryEnvelopeSchema = z.object({
  action: z.string().min(1),
  installation: z.object({ uuid: z.uuid().toLowerCase() }),
  data: z.record(z.string(), z.unknown()),
  actor: z
    .object({
      id: z.union([z.string(), z.number()]),
      type: z.string(),
      name: z.string().optional(),
    })
    .optional(),
});
export type SentryEnvelope = z.infer<typeof SentryEnvelopeSchema>;
const TokenSchema = z.object({
  token: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});
export class SentryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get transient() {
    return this.status === 429 || this.status >= 500;
  }
}
export function sentryConfigured() {
  return Boolean(
    process.env.SENTRY_APP_CLIENT_ID &&
      process.env.SENTRY_APP_CLIENT_SECRET &&
      process.env.SENTRY_APP_SLUG,
  );
}
export function sentryApiBase(region: "us" | "eu") {
  return region === "eu" ? "https://de.sentry.io/api/0/" : "https://us.sentry.io/api/0/";
}
export function verifySentrySignature(
  raw: string,
  signature: string | null,
  secret = process.env.SENTRY_APP_CLIENT_SECRET ?? "",
) {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    createHmac("sha256", secret).update(raw).digest(),
  );
}
export function sentryRefreshJwt(now = new Date()) {
  const id = process.env.SENTRY_APP_CLIENT_ID;
  const secret = process.env.SENTRY_APP_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Sentry app credentials are not configured.");
  const iat = Math.floor(now.getTime() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ iss: id, sub: id, iat, exp: iat + 60, jti: randomUUID() }),
  ).toString("base64url");
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
export async function exchangeSentryGrant(installationId: string, code: string) {
  return TokenSchema.parse(
    (
      await sentryRequest(
        `sentry-app-installations/${encodeURIComponent(installationId)}/authorizations/`,
        {
          grant_type: "authorization_code",
          code,
          client_id: process.env.SENTRY_APP_CLIENT_ID,
          client_secret: process.env.SENTRY_APP_CLIENT_SECRET,
        },
        undefined,
        "https://sentry.io/api/0/",
        "POST",
      )
    ).data,
  );
}
export async function sentryAccessToken(
  connection: SentryConnection,
  options: { db?: any; signal?: AbortSignal; refreshIfAccessToken?: string } = {},
) {
  return getExpiringOAuthAccessToken({
    connection: {
      integrationId: connection.integrationId,
      userWorkosId: connection.userWorkosId,
      provider: "sentry",
    },
    displayName: "Sentry",
    parseCredential(payload) {
      return typeof payload.access_token === "string" && payload.access_token
        ? {
            accessToken: payload.access_token,
            refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
            payload,
          }
        : null;
    },
    async refresh(_credential, context) {
      let response;
      try {
        response = await sentryRequest(
          `sentry-app-installations/${encodeURIComponent(connection.installationId)}/authorizations/`,
          { grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer" },
          sentryRefreshJwt(context.now),
          "https://sentry.io/api/0/",
          "POST",
          context.signal,
        );
      } catch (error) {
        createLogger({ service: "opencompany-agent", runtime: "sentry" }).warn(
          "Sentry installation token refresh failed",
          {
            event: "opencompany.sentry_refresh_failed",
            integration_id: connection.integrationId,
            workspace_id: connection.workspaceId,
            status: error instanceof SentryApiError ? error.status : null,
          },
        );
        if (error instanceof SentryApiError && [400, 401, 403].includes(error.status))
          throw new ExpiringOAuthReauthRequired(
            "Reconnect the Sentry installation.",
            "Sentry installation token refresh was rejected.",
          );
        throw error;
      }
      const tokens = TokenSchema.parse(response.data);
      const expiresAt = new Date(tokens.expiresAt);
      if (expiresAt <= context.now) throw new Error("Sentry returned an expired token.");
      return {
        accessToken: tokens.token,
        payload: { access_token: tokens.token, refresh_token: tokens.refreshToken },
        expiresAt,
      };
    },
    createAuthError: (message) => new ActionAuthError("auth_expired", "sentry", message),
    missingCredential: {
      message: "Reconnect Sentry.",
      statusReason: "Sentry credentials are missing.",
    },
    invalidCredential: {
      message: "Reconnect Sentry.",
      statusReason: "Sentry credentials are invalid.",
    },
    options,
  });
}
export async function sentryRequest(
  path: string,
  params: URLSearchParams | Record<string, unknown> = new URLSearchParams(),
  token?: string,
  base = "https://sentry.io/api/0/",
  method = "GET",
  signal?: AbortSignal,
): Promise<{ data: unknown; nextCursor: string | null; source: string }> {
  if (
    path.startsWith("/") ||
    path.includes(":") ||
    path.includes("\\") ||
    !path.endsWith("/") ||
    path.split("/").some((segment) => [".", ".."].includes(decodeURIComponent(segment)))
  )
    throw new Error("Invalid Sentry API path.");
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname))
    throw new Error("Invalid Sentry API path.");
  if (method === "GET" && params instanceof URLSearchParams) url.search = params.toString();
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    ...(method !== "GET" ? { body: JSON.stringify(params) } : {}),
  });
  if (!response.ok)
    throw new SentryApiError(
      response.status,
      response.status === 403
        ? "Sentry permissions do not allow this endpoint."
        : response.status === 404
          ? "Sentry data is unavailable or the resource is inaccessible."
          : `Sentry request failed with status ${response.status}.`,
    );
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 1_000_000) {
          await reader.cancel();
          throw new Error("Sentry response exceeded the data limit. Narrow the query.");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const next = response.headers
    .get("link")
    ?.split(",")
    .find((link) => /rel="next"/.test(link) && /results="true"/.test(link));
  const nextCursor = next?.match(/cursor="([^"]+)"/)?.[1] ?? null;
  return { data: text ? JSON.parse(text) : null, nextCursor, source: url.toString() };
}
export async function sentryApi(
  connection: SentryConnection,
  path: string,
  params: URLSearchParams | Record<string, unknown> = new URLSearchParams(),
  options: { method?: string; db?: any; signal?: AbortSignal } = {},
) {
  let token = await sentryAccessToken(connection, options);
  try {
    return await sentryRequest(
      path,
      params,
      token,
      sentryApiBase(connection.region),
      options.method,
      options.signal,
    );
  } catch (error) {
    if (
      !(error instanceof SentryApiError) ||
      error.status !== 401 ||
      (options.method && options.method !== "GET")
    )
      throw error;
    token = await sentryAccessToken(connection, { ...options, refreshIfAccessToken: token });
    return sentryRequest(
      path,
      params,
      token,
      sentryApiBase(connection.region),
      options.method,
      options.signal,
    );
  }
}
export function sentryIssuePath(connection: SentryConnection, issueId: string) {
  return `organizations/${encodeURIComponent(connection.organizationSlug)}/issues/${encodeURIComponent(issueId)}/`;
}
export function sentryOccurrenceId(event: SentryOccurrence) {
  const id = event.eventID ?? event.event_id ?? event.id;
  return id && /^[a-fA-F0-9]{32}$/.test(id) ? id : null;
}
export function sentryOccurrenceDate(event: SentryOccurrence) {
  const value = event.dateCreated ?? event.datetime ?? event.timestamp;
  if (value === undefined) return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function sentryEventType(resource: string, payload: SentryEnvelope): string | null {
  const issue = payload.data.issue as Record<string, unknown> | undefined;
  if (resource === "issue" && payload.action === "created" && issue?.issueCategory === "error")
    return "issue.created";
  if (resource === "issue" && payload.action === "unresolved" && issue?.substatus === "regressed")
    return "issue.regressed";
  if (resource === "event_alert" && payload.action === "triggered") return "issue_alert.triggered";
  return null;
}
export function sentryConditionsMatch(
  filters: Record<string, { id: string; pairs?: { key: string; value: string }[] }>,
  issue: SentryIssue,
  occurrence: SentryOccurrence | null,
): string | null {
  if (filters.project?.id !== issue.project.id) return "conditions not matched: project";
  if (filters.priority && filters.priority.id !== issue.priority)
    return "conditions not matched: priority";
  if (!occurrence) return "occurrence context unavailable";
  const tags = new Map(
    occurrence.tags?.map((tag) => (Array.isArray(tag) ? tag : [tag.key, tag.value])) as
      | [string, string][]
      | undefined,
  );
  const environment = occurrence.environment ?? tags.get("environment");
  if (filters.environment && environment === undefined)
    return "occurrence context unavailable: environment";
  if (filters.environment && environment !== filters.environment.id)
    return "conditions not matched: environment";
  for (const pair of filters.tags?.pairs ?? []) {
    if (!tags.has(pair.key)) return "conditions not matched: missing tag";
    if (tags.get(pair.key) !== pair.value) return "conditions not matched: tags";
  }
  return null;
}
