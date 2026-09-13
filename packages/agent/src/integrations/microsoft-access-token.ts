import { getDb } from "@opencompany/db/client";
import { markIntegrationStatus } from "@opencompany/db/integrations";
import {
  ExpiringOAuthReauthRequired,
  getExpiringOAuthAccessToken,
} from "./expiring-oauth-access-token";
import {
  MICROSOFT_TOKEN_ENDPOINT,
  type MicrosoftIntegrationProvider,
  microsoftTokensSchema,
} from "./microsoft-oauth";

export type MicrosoftAccessConnection = {
  userWorkosId: string;
  integrationId: string;
  provider: MicrosoftIntegrationProvider;
};
export class MicrosoftAccessAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftAccessAuthError";
  }
}

export function assertGraphUrl(url: URL) {
  if (
    url.origin !== "https://graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/me/") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Untrusted Microsoft Graph URL.");
}

export async function graphApiCall(
  connection: MicrosoftAccessConnection,
  method: string,
  url: URL,
  options?: { signal?: AbortSignal; body?: unknown },
): Promise<unknown> {
  const response = await graphRequest(connection, method, url, options);
  if (response.status === 204 || response.status === 202) return {};
  const bytes = await readBoundedGraphBody(response, 4 * 1024 * 1024);
  try {
    return bytes.length ? (JSON.parse(bytes.toString("utf8")) as unknown) : {};
  } catch {
    throw new Error("Microsoft Graph returned invalid JSON.");
  }
}

export async function graphApiDownload(
  connection: MicrosoftAccessConnection,
  url: URL,
  options: { signal?: AbortSignal; maxBytes: number },
) {
  const response = await graphRequest(connection, "GET", url, options);
  return {
    bytes: await readBoundedGraphBody(response, options.maxBytes),
    contentType: response.headers.get("content-type"),
  };
}

async function graphRequest(
  connection: MicrosoftAccessConnection,
  method: string,
  url: URL,
  options?: { signal?: AbortSignal; body?: unknown },
) {
  assertGraphUrl(url);
  const run = (token: string) =>
    fetch(url, {
      method,
      redirect: "error",
      signal: options?.signal ?? null,
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.body-content-type="text", outlook.timezone="UTC"',
        ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  const tokenOptions = options?.signal ? { signal: options.signal } : {};
  let response = await run(await getMicrosoftAccessToken(connection, tokenOptions));
  if (response.status === 401) {
    await response.body?.cancel();
    response = await run(
      await getMicrosoftAccessToken(connection, { ...tokenOptions, forceRefresh: true }),
    );
  }
  if (response.status === 401) {
    await response.body?.cancel();
    await markIntegrationStatus({
      ...connection,
      status: "needs_reauth",
      statusReason: "Microsoft rejected API access.",
      db: getDb(),
    });
    throw new MicrosoftAccessAuthError("Reconnect this Microsoft account to restore access.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Never include provider error bodies: they can echo mailbox content or credentials.
    if (response.status === 403)
      throw new Error(
        "Microsoft denied this operation. Check account permissions and your organization's consent policy.",
      );
    if (response.status === 429)
      throw new Error("Microsoft Graph is rate limiting this account. Try again later.");
    throw new Error(`Microsoft Graph request failed with ${response.status}.`);
  }
  return response;
}

async function readBoundedGraphBody(response: Response, maxBytes: number) {
  const tooLarge = () =>
    new Error(
      `Microsoft Graph response exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`,
    );
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function getMicrosoftAccessToken(
  connection: MicrosoftAccessConnection,
  options?: { signal?: AbortSignal; forceRefresh?: boolean },
) {
  return getExpiringOAuthAccessToken({
    connection,
    displayName: "Microsoft",
    createAuthError: (message) => new MicrosoftAccessAuthError(message),
    missingCredential: {
      message: "Microsoft credentials are missing.",
      statusReason: "Microsoft credentials are missing.",
    },
    invalidCredential: {
      message: "Microsoft credentials are invalid.",
      statusReason: "Microsoft credentials are invalid.",
    },
    parseCredential: (payload) => {
      if (typeof payload.access_token !== "string" || !payload.access_token.trim()) return null;
      return {
        accessToken: payload.access_token,
        refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
        payload,
      };
    },
    refresh: async (credential, context) => {
      const refreshToken = credential.refreshToken;
      if (!refreshToken)
        throw new ExpiringOAuthReauthRequired(
          "Microsoft refresh token is missing.",
          "Microsoft refresh token is missing.",
        );
      const clientId = process.env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
      const clientSecret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
      if (!clientId || !clientSecret) throw new Error("Microsoft OAuth is not configured.");
      const response = await fetch(MICROSOFT_TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: context.signal ?? null,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: unknown } | null;
        if (
          ["invalid_grant", "interaction_required", "consent_required"].includes(
            String(error?.error),
          )
        )
          throw new ExpiringOAuthReauthRequired(
            "Microsoft refused the refresh token. Reconnect this account.",
            "Microsoft refused the refresh token.",
          );
        throw new Error(`Microsoft token refresh failed with ${response.status}.`);
      }
      const parsed = microsoftTokensSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Microsoft returned invalid refreshed credentials.");
      const { expires_in, ...tokens } = parsed.data;
      return {
        accessToken: tokens.access_token,
        payload: { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken },
        expiresAt: new Date(context.now.getTime() + expires_in * 1000),
      };
    },
    ...(options ? { options } : {}),
  });
}
