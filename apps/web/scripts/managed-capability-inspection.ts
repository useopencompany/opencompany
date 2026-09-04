import type { MonidInspection } from "../lib/capabilities/monid";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

type FetchLike = typeof fetch;

export class ManagedCapabilityInspectionError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ManagedCapabilityInspectionError";
    this.transient = transient;
  }
}

export async function inspectManagedCapability(
  input: {
    apiKey: string;
    provider: string;
    endpoint: string;
  },
  options: {
    fetchImpl?: FetchLike;
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<MonidInspection> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? wait;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Managed capability inspection attempts must be a positive integer.");
  }

  let lastFailure: InspectionFailure | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestInspection(fetchImpl, input);
    if (result.ok) return result.inspection;

    lastFailure = result.failure;
    if (!result.failure.transient || attempt === attempts) break;
    await sleep(result.failure.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS * attempt);
  }

  const failure = lastFailure ?? {
    message: "Capability inspection failed.",
    transient: false,
  };
  const message = failure.message.replace(/\.$/u, "");
  throw new ManagedCapabilityInspectionError(
    `${message}${failure.transient && attempts > 1 ? ` after ${attempts} attempts` : ""}.`,
    failure.transient,
  );
}

type InspectionFailure = {
  message: string;
  transient: boolean;
  retryAfterMs?: number;
};

type InspectionResult =
  | { ok: true; inspection: MonidInspection }
  | { ok: false; failure: InspectionFailure };

async function requestInspection(
  fetchImpl: FetchLike,
  input: { apiKey: string; provider: string; endpoint: string },
): Promise<InspectionResult> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.monid.ai/v1/inspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: input.provider, endpoint: input.endpoint }),
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        message: `Capability inspection request failed: ${errorName(error)}.`,
        transient: true,
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: {
        message: `Capability inspection request returned HTTP ${response.status}.`,
        transient:
          TRANSIENT_HTTP_STATUSES.has(response.status) ||
          (response.status >= 500 && response.status <= 599),
        ...(retryAfterMilliseconds(response.headers.get("retry-after")) ?? {}),
      },
    };
  }

  const value = await response.json().catch(() => null);
  if (!isRecord(value) || !isRecord(value.price)) {
    return {
      ok: false,
      failure: {
        message: "Capability inspection returned a malformed success response.",
        transient: true,
      },
    };
  }

  return { ok: true, inspection: value as unknown as MonidInspection };
}

function retryAfterMilliseconds(
  value: string | null,
): Pick<InspectionFailure, "retryAfterMs"> | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return { retryAfterMs: Math.ceil(seconds * 1_000) };
}

function errorName(error: unknown) {
  return error instanceof Error && error.name ? error.name : "network error";
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
