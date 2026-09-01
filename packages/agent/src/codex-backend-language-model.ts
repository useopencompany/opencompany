import { createOpenAI } from "@ai-sdk/openai";
import {
  type CodexAuthJson,
  type LoadedCodexCredential,
  loadCodexCredential,
  markCodexCredentialNeedsReauth,
  releaseCodexCredentialRefreshLock,
  rotateCodexCredential,
  tryAcquireCodexCredentialRefreshLock,
} from "@opencompany/db/codex-auth";
import type { LanguageModel } from "ai";

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_BACKEND_RESPONSES_URL = `${CODEX_BACKEND_BASE_URL}/responses`;
export const CODEX_BACKEND_CLIENT_VERSION = "0.147.0";

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_SKEW_MS = 60_000;
const REFRESH_WAIT_MS = 5_000;

type DbLike = any;
type FetchLike = typeof fetch;

type CodexTokens = {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string;
  expiresAtMs: number | null;
};

export type CodexBackendErrorKind = "needs_reauth" | "usage_limit" | "backend_error";

export class CodexBackendError extends Error {
  readonly kind: CodexBackendErrorKind;
  readonly statusCode: number;

  constructor(kind: CodexBackendErrorKind, message: string, statusCode = 500) {
    super(message);
    this.name = "CodexBackendError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export function codexBackendProviderOptions(): any {
  return {
    openai: {
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    },
  };
}

export function createCodexBackendLanguageModel(input: {
  db: DbLike;
  userWorkosId: string;
  modelId: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): LanguageModel {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const wait =
    input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const tokenManager = createCodexTokenManager({ ...input, fetchImpl, now, wait });

  const authenticatedFetch: FetchLike = async (request, init) => {
    let tokens = await tokenManager.getTokens(false);
    let response = await sendCodexRequest({ request, init, tokens, fetchImpl });
    if (response.status === 401) {
      tokens = await tokenManager.getTokens(true);
      response = await sendCodexRequest({ request, init, tokens, fetchImpl });
    }

    if (response.status === 401) {
      await markCodexCredentialNeedsReauth({
        db: input.db,
        userWorkosId: input.userWorkosId,
        statusReason: "Codex authentication expired. Reconnect Codex in Settings.",
      });
      return openAIErrorResponse(
        401,
        "Codex authentication expired — reconnect Codex in Settings.",
        "codex_needs_reauth",
      );
    }
    if (response.status === 429) {
      const retryHint = retryAfterHint(response.headers.get("retry-after"));
      return openAIErrorResponse(
        429,
        `ChatGPT usage limit reached — try again later or switch model.${retryHint}`,
        "codex_usage_limit",
        response.headers,
      );
    }
    if (!response.ok) {
      return openAIErrorResponse(
        response.status,
        `Codex API error (HTTP ${response.status}).`,
        "codex_backend_error",
        response.headers,
      );
    }
    return response;
  };

  const provider = createOpenAI({
    apiKey: "subscription-auth-is-injected-by-custom-fetch",
    baseURL: CODEX_BACKEND_BASE_URL,
    name: "codex-backend",
    fetch: authenticatedFetch,
  });
  return provider.responses(stripOpenAiModelPrefix(input.modelId));
}

function createCodexTokenManager(input: {
  db: DbLike;
  userWorkosId: string;
  fetchImpl: FetchLike;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}) {
  return {
    async getTokens(forceRefresh: boolean): Promise<CodexTokens> {
      let credential = await requireConnectedCredential(input);
      let tokens = parseCodexTokens(credential.authJson);
      if (!forceRefresh && tokenIsFresh(tokens, input.now())) return tokens;

      const observedRotation = credential.lastRotatedAt?.getTime() ?? 0;
      const deadline = input.now() + REFRESH_WAIT_MS;
      while (true) {
        const lock = await tryAcquireCodexCredentialRefreshLock({
          db: input.db,
          userWorkosId: input.userWorkosId,
          now: new Date(input.now()),
        });
        if (lock) {
          try {
            credential = await requireConnectedCredential(input);
            tokens = parseCodexTokens(credential.authJson);
            const wasRefreshedByAnotherRequest =
              (credential.lastRotatedAt?.getTime() ?? 0) > observedRotation;
            if (wasRefreshedByAnotherRequest && tokenIsFresh(tokens, input.now())) return tokens;
            return await refreshCodexTokens(input, credential, tokens);
          } finally {
            await releaseCodexCredentialRefreshLock({
              db: input.db,
              userWorkosId: input.userWorkosId,
              lockId: lock.lockId,
            });
          }
        }

        credential = await requireConnectedCredential(input);
        tokens = parseCodexTokens(credential.authJson);
        if (
          (credential.lastRotatedAt?.getTime() ?? 0) > observedRotation &&
          tokenIsFresh(tokens, input.now())
        ) {
          return tokens;
        }
        if (input.now() >= deadline) {
          throw new CodexBackendError(
            "backend_error",
            "Codex authentication refresh is busy. Try again in a moment.",
            503,
          );
        }
        await input.wait(100);
      }
    },
  };
}

async function requireConnectedCredential(input: {
  db: DbLike;
  userWorkosId: string;
}): Promise<LoadedCodexCredential> {
  const credential = await loadCodexCredential(input);
  if (!credential || credential.status !== "connected") {
    throw new CodexBackendError(
      "needs_reauth",
      "Codex authentication expired — reconnect Codex in Settings.",
      401,
    );
  }
  return credential;
}

async function refreshCodexTokens(
  input: {
    db: DbLike;
    userWorkosId: string;
    fetchImpl: FetchLike;
    now: () => number;
  },
  credential: LoadedCodexCredential,
  tokens: CodexTokens,
) {
  if (!tokens.refreshToken) {
    await markNeedsReauth(input, "Codex refresh token is missing. Reconnect Codex in Settings.");
  }

  let response: Response;
  try {
    response = await input.fetchImpl(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken!,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
    });
  } catch {
    return markNeedsReauth(input, "Codex token refresh failed. Reconnect Codex in Settings.");
  }
  if (!response.ok) {
    await markNeedsReauth(input, "Codex token refresh failed. Reconnect Codex in Settings.");
  }

  const result = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
  } | null;
  if (typeof result?.access_token !== "string" || !result.access_token.trim()) {
    await markNeedsReauth(input, "Codex token refresh returned no access token.");
  }

  const previousTokens = asRecord(credential.authJson.tokens);
  const authJson: CodexAuthJson = {
    ...credential.authJson,
    tokens: {
      ...previousTokens,
      access_token: result!.access_token,
      refresh_token:
        typeof result!.refresh_token === "string" && result!.refresh_token.trim()
          ? result!.refresh_token
          : tokens.refreshToken,
      id_token:
        typeof result!.id_token === "string" && result!.id_token.trim()
          ? result!.id_token
          : tokens.idToken,
    },
    last_refresh: new Date(input.now()).toISOString(),
  };
  const rotated = await rotateCodexCredential({
    db: input.db,
    userWorkosId: input.userWorkosId,
    authJson,
    expectedLastRotatedAt: credential.lastRotatedAt,
    now: new Date(input.now()),
  });
  if (!rotated) {
    const latest = await requireConnectedCredential(input);
    return parseCodexTokens(latest.authJson);
  }
  return parseCodexTokens(authJson);
}

async function markNeedsReauth(
  input: { db: DbLike; userWorkosId: string },
  reason: string,
): Promise<never> {
  await markCodexCredentialNeedsReauth({
    db: input.db,
    userWorkosId: input.userWorkosId,
    statusReason: reason,
  });
  throw new CodexBackendError(
    "needs_reauth",
    "Codex authentication expired — reconnect Codex in Settings.",
    401,
  );
}

async function sendCodexRequest(input: {
  request: Parameters<FetchLike>[0];
  init?: Parameters<FetchLike>[1];
  tokens: CodexTokens;
  fetchImpl: FetchLike;
}) {
  const headers = new Headers(input.init?.headers);
  headers.set("authorization", `Bearer ${input.tokens.accessToken}`);
  headers.set("chatgpt-account-id", input.tokens.accountId);
  headers.set("content-type", "application/json");
  headers.set("openai-beta", "responses=experimental");
  headers.set("originator", "opencompany");
  headers.set("user-agent", `opencompany/${CODEX_BACKEND_CLIENT_VERSION}`);

  const url = new URL(CODEX_BACKEND_RESPONSES_URL);
  url.searchParams.set("client_version", CODEX_BACKEND_CLIENT_VERSION);
  const normalizedBody = normalizeCodexRequestBody(input.init?.body);
  return input.fetchImpl(url, {
    ...input.init,
    headers,
    ...(normalizedBody === undefined ? {} : { body: normalizedBody }),
  });
}

export function normalizeCodexRequestBody(
  body: BodyInit | null | undefined,
): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;

  delete parsed.max_output_tokens;
  delete parsed.previous_response_id;
  parsed.store = false;
  parsed.include = ["reasoning.encrypted_content"];
  if (Array.isArray(parsed.input)) {
    parsed.input = parsed.input
      .filter((item) => !isRecord(item) || item.type !== "item_reference")
      .map(stripServerItemIds);
  }
  return JSON.stringify(parsed);
}

function stripServerItemIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripServerItemIds);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "id") normalized[key] = stripServerItemIds(child);
  }
  return normalized;
}

function parseCodexTokens(authJson: CodexAuthJson): CodexTokens {
  const stored = asRecord(authJson.tokens);
  const accessToken = stringValue(stored.access_token ?? authJson.access_token);
  const refreshToken = stringValue(stored.refresh_token ?? authJson.refresh_token);
  const idToken = stringValue(stored.id_token ?? authJson.id_token);
  if (!accessToken) {
    throw new CodexBackendError(
      "needs_reauth",
      "Codex authentication expired — reconnect Codex in Settings.",
      401,
    );
  }
  const accessClaims = parseJwtClaims(accessToken);
  const idClaims = idToken ? parseJwtClaims(idToken) : null;
  const accountId =
    stringValue(asRecord(accessClaims?.["https://api.openai.com/auth"]).chatgpt_account_id) ??
    stringValue(asRecord(idClaims?.["https://api.openai.com/auth"]).chatgpt_account_id) ??
    stringValue(stored.account_id ?? authJson.account_id);
  if (!accountId) {
    throw new CodexBackendError(
      "needs_reauth",
      "Codex account information is missing — reconnect Codex in Settings.",
      401,
    );
  }
  const exp = typeof accessClaims?.exp === "number" ? accessClaims.exp * 1_000 : null;
  return { accessToken, refreshToken, idToken, accountId, expiresAtMs: exp };
}

function tokenIsFresh(tokens: CodexTokens, now: number) {
  return tokens.expiresAtMs === null || tokens.expiresAtMs > now + REFRESH_SKEW_MS;
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function openAIErrorResponse(
  status: number,
  message: string,
  code: string,
  sourceHeaders?: Headers,
) {
  const headers = new Headers({ "content-type": "application/json" });
  const retryAfter = sourceHeaders?.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers,
  });
}

function stripOpenAiModelPrefix(modelId: string) {
  return modelId.startsWith("openai/") ? modelId.slice("openai/".length) : modelId;
}

function retryAfterHint(value: string | null) {
  const normalized = value?.trim();
  if (!normalized) return "";
  if (/^\d{1,6}$/u.test(normalized)) return ` Retry after ${normalized} seconds.`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? ` Retry after ${new Date(timestamp).toISOString()}.` : "";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
