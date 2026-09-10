import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { getAppUrl } from "../app-url";

import {
  MICROSOFT_PROVIDER_CONFIG,
  type MicrosoftIntegrationProvider,
  microsoftScopesSatisfied,
} from "./microsoft-scopes";

export {
  MICROSOFT_PROVIDER_CONFIG,
  type MicrosoftIntegrationProvider,
  microsoftScopesSatisfied,
} from "./microsoft-scopes";
export const MICROSOFT_TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const stateSchema = z
  .object({
    provider: z.enum(["outlook", "outlook-calendar"]),
    userWorkosId: z.string().min(1).max(256),
    returnTo: z.string().max(2048),
    expiresAt: z.number().int().positive(),
    nonce: z.string().uuid(),
  })
  .strict();

export const microsoftTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(),
});
export type MicrosoftOAuthTokens = Omit<z.infer<typeof microsoftTokensSchema>, "expires_in">;

export function isMicrosoftIntegrationConfigured() {
  return [
    "MICROSOFT_OAUTH_CLIENT_ID",
    "MICROSOFT_OAUTH_CLIENT_SECRET",
    "MICROSOFT_INTEGRATION_STATE_SECRET",
    "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
  ].every((name) => Boolean(process.env[name]?.trim()));
}

export function sanitizeMicrosoftReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/u.test(value))
    return "/settings";
  const url = new URL(value, "https://opencompany.invalid");
  return `${url.pathname}${url.search}`;
}

export function createMicrosoftIntegrationState(input: {
  provider: MicrosoftIntegrationProvider;
  userWorkosId: string;
  returnTo: string;
}) {
  const payload = stateSchema.parse({
    ...input,
    returnTo: sanitizeMicrosoftReturnTo(input.returnTo),
    expiresAt: Date.now() + 600_000,
    nonce: crypto.randomUUID(),
  });
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, "state")}`;
}

export function verifyMicrosoftIntegrationState(state: string) {
  const parts = state.split(".");
  if (state.length > 8192 || parts.length !== 2)
    throw new Error("Invalid Microsoft integration state.");
  const [body, signature] = parts;
  const expected = Buffer.from(sign(body!, "state"));
  const supplied = Buffer.from(signature!);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new Error("Invalid Microsoft integration state.");
  const payload = stateSchema.parse(JSON.parse(Buffer.from(body!, "base64url").toString("utf8")));
  if (payload.expiresAt <= Date.now()) throw new Error("Microsoft integration state expired.");
  return { ...payload, returnTo: sanitizeMicrosoftReturnTo(payload.returnTo) };
}

export function microsoftOAuthRedirectUri(provider: MicrosoftIntegrationProvider) {
  return `${getAppUrl().replace(/\/$/, "")}/api/integrations/${provider}/callback`;
}

export function buildMicrosoftAuthorizationUrl(
  provider: MicrosoftIntegrationProvider,
  state: string,
) {
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.search = new URLSearchParams({
    client_id: requiredEnv("MICROSOFT_OAUTH_CLIENT_ID"),
    response_type: "code",
    response_mode: "query",
    prompt: "select_account",
    redirect_uri: microsoftOAuthRedirectUri(provider),
    scope: MICROSOFT_PROVIDER_CONFIG[provider].scopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(pkceVerifier(state)).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeMicrosoftCode(
  provider: MicrosoftIntegrationProvider,
  code: string,
  state: string,
) {
  const response = await fetch(MICROSOFT_TOKEN_ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("MICROSOFT_OAUTH_CLIENT_ID"),
      client_secret: requiredEnv("MICROSOFT_OAUTH_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      code_verifier: pkceVerifier(state),
      redirect_uri: microsoftOAuthRedirectUri(provider),
      scope: MICROSOFT_PROVIDER_CONFIG[provider].scopes.join(" "),
    }),
  });
  if (!response.ok) throw new Error(`Microsoft token exchange failed with ${response.status}.`);
  const parsed = microsoftTokensSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Microsoft returned invalid OAuth credentials.");
  const { expires_in, ...tokens } = parsed.data;
  if (!tokens.refresh_token || !microsoftScopesSatisfied(provider, tokens.scope.split(/\s+/u)))
    throw new Error("Microsoft did not grant the required offline access and permissions.");
  return {
    tokens: { ...tokens, refresh_token: tokens.refresh_token },
    expiresAt: new Date(Date.now() + expires_in * 1000),
  };
}

export async function fetchMicrosoftUserInfo(accessToken: string) {
  const response = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error(`Microsoft account lookup failed with ${response.status}.`);
  const parsed = z
    .object({
      id: z.string().min(1),
      displayName: z.string().nullish(),
      mail: z.string().nullish(),
      userPrincipalName: z.string().nullish(),
    })
    .safeParse(await response.json());
  if (!parsed.success) throw new Error("Microsoft returned an invalid account identity.");
  return parsed.data;
}

// Derive a verifier on the server so the public OAuth state cannot reveal it.
function pkceVerifier(state: string) {
  return sign(state, "pkce");
}
function sign(value: string, context: string) {
  return createHmac("sha256", requiredEnv("MICROSOFT_INTEGRATION_STATE_SECRET"))
    .update(`opencompany-microsoft-${context}\0`)
    .update(value)
    .digest("base64url");
}
function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Microsoft integrations.`);
  return value;
}
