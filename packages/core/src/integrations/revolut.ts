export const REVOLUT_BUSINESS_PROVIDER = "revolut" as const;
export const REVOLUT_BUSINESS_API_BASE_URL = "https://b2b.revolut.com/api/1.0";
export const REVOLUT_BUSINESS_SANDBOX_API_BASE_URL = "https://sandbox-b2b.revolut.com/api/1.0";

const REVOLUT_API_TIMEOUT_MS = 15_000;
const MAX_REVOLUT_ERROR_DETAIL_CHARS = 240;

export type RevolutBusinessConnection = {
  workspaceId: string;
  accountLabel: string;
  apiToken: string;
  apiBaseUrl: string;
  environment: "production" | "sandbox" | "custom";
};

type RevolutApiErrorPayload = {
  code?: string;
  error?: string | { code?: string; message?: string };
  error_description?: string;
  message?: string;
};

export class RevolutApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;

  constructor(status: number, path: string, payload?: RevolutApiErrorPayload | null) {
    super(`Revolut Business API GET ${path} failed (${status}).`);
    this.name = "RevolutApiError";
    this.status = status;
    this.code = boundedRevolutErrorString(
      typeof payload?.error === "object" ? payload.error.code : payload?.code,
    );
    this.detail = boundedRevolutErrorString(
      typeof payload?.error === "object"
        ? payload.error.message
        : (payload?.error_description ?? payload?.message ?? payload?.error),
    );
  }
}

export function loadRevolutBusinessConnection(
  workspaceId: string,
): RevolutBusinessConnection | null {
  const allowedWorkspaceId = process.env.REVOLUT_BUSINESS_WORKSPACE_ID?.trim();
  if (!allowedWorkspaceId || allowedWorkspaceId !== workspaceId) return null;

  const apiToken = process.env.REVOLUT_BUSINESS_API_TOKEN?.trim();
  if (!apiToken || !isPlausibleRevolutBusinessApiToken(apiToken)) return null;

  const apiBaseUrl = normalizeRevolutApiBaseUrl(
    process.env.REVOLUT_BUSINESS_API_BASE_URL,
    apiToken,
  );
  const accountLabel = cleanRevolutLabel(process.env.REVOLUT_BUSINESS_ACCOUNT_LABEL);
  return {
    workspaceId,
    accountLabel: accountLabel ?? "Revolut Business",
    apiToken,
    apiBaseUrl,
    environment: inferRevolutEnvironment(apiBaseUrl, apiToken),
  };
}

export async function requestRevolutBusinessApi<T>(input: {
  connection: RevolutBusinessConnection;
  path: string;
  params?: Readonly<Record<string, string | number | boolean | undefined>>;
  signal?: AbortSignal;
}): Promise<T> {
  const url = new URL(`${input.connection.apiBaseUrl}${input.path}`);
  for (const [key, value] of Object.entries(input.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.connection.apiToken}`,
        Accept: "application/json",
      },
      signal: input.signal ?? AbortSignal.timeout(REVOLUT_API_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw error;
    }
    throw new Error("Could not reach the Revolut Business API.");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as RevolutApiErrorPayload | null;
    throw new RevolutApiError(response.status, input.path, payload);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function isPlausibleRevolutBusinessApiToken(value: string) {
  return /^oa_(?:prod|sand)_[^\s]{16,500}$/.test(value);
}

function normalizeRevolutApiBaseUrl(value: string | undefined, apiToken: string) {
  const trimmed = value?.trim();
  if (!trimmed) return defaultRevolutApiBaseUrl(apiToken);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return defaultRevolutApiBaseUrl(apiToken);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return defaultRevolutApiBaseUrl(apiToken);
  }
}

function inferRevolutEnvironment(
  apiBaseUrl: string,
  apiToken: string,
): RevolutBusinessConnection["environment"] {
  if (apiToken.startsWith("oa_sand_") || apiBaseUrl.includes("sandbox")) return "sandbox";
  if (apiBaseUrl === REVOLUT_BUSINESS_API_BASE_URL && apiToken.startsWith("oa_prod_")) {
    return "production";
  }
  return "custom";
}

function defaultRevolutApiBaseUrl(apiToken: string) {
  return apiToken.startsWith("oa_sand_")
    ? REVOLUT_BUSINESS_SANDBOX_API_BASE_URL
    : REVOLUT_BUSINESS_API_BASE_URL;
}

function cleanRevolutLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function boundedRevolutErrorString(value: unknown): string | undefined {
  const normalized = cleanRevolutLabel(value);
  if (!normalized) return undefined;
  return normalized.length > MAX_REVOLUT_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_REVOLUT_ERROR_DETAIL_CHARS - 3)}...`
    : normalized;
}
