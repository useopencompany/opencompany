import "server-only";

export const MONID_API_BASE_URL = "https://api.monid.ai";

export type MonidMoney = {
  value: number;
  currency: "USD";
};

export type MonidPrice = {
  type: string;
  amount: number;
  currency: "USD";
  flatFee?: number;
  notes?: string[];
};

export type MonidInspection = {
  id: string;
  provider: string;
  endpoint: string;
  method?: string;
  input?: unknown;
  price?: MonidPrice;
  tags: string[];
};

export type MonidRunStatus =
  | "READY"
  | "RUNNING"
  | "STOPPING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "STOPPED"
  | "TIMED_OUT";

export type MonidRun = {
  runId: string;
  provider: string;
  endpoint: string;
  status: MonidRunStatus;
  output?: unknown;
  providerResponse?: {
    httpStatus?: number;
    error?: unknown;
  } | null;
  price?: MonidPrice;
  cost?: MonidMoney | null;
  billing?: {
    calculatedCost?: { value: number; unit: string; currency: string };
    actualCost?: { value: number; unit: string; currency: string };
    reportedCost?: { value: number; unit: string; currency: string };
  };
  billedUnits?: number;
  resultCount?: number;
  reason?: string;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type MonidRunResponse = {
  async: boolean;
  httpStatus: number;
  run: MonidRun;
};

export class MonidApiError extends Error {
  readonly status: number;
  readonly runId: string | undefined;
  readonly async: boolean | undefined;

  constructor(message: string, status: number, context?: { runId?: string; async?: boolean }) {
    super(message);
    this.name = "MonidApiError";
    this.status = status;
    this.runId = context?.runId;
    this.async = context?.async;
  }
}

type FetchLike = typeof fetch;

export class MonidClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(input: { apiKey: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new Error("MONID_API_KEY is required for managed capabilities.");
    this.#apiKey = apiKey;
    this.#baseUrl = (input.baseUrl ?? MONID_API_BASE_URL).replace(/\/+$/, "");
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async inspect(
    input: { provider: string; endpoint: string },
    signal?: AbortSignal,
  ): Promise<MonidInspection> {
    const response = await this.#request("/v1/inspect", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await monidHttpError(response, "Could not inspect capability pricing.");
    return parseMonidInspection(await readJson(response));
  }

  async run(
    input: { provider: string; endpoint: string; input: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<MonidRunResponse> {
    const response = await this.#request("/v1/run", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify(input),
    });
    const body = await readJson(response);
    // Synchronous provider errors mirror the provider's HTTP status. They
    // still carry a valid completed run and must be settled as zero-cost.
    if (!response.ok && (!isRecord(body) || typeof body.runId !== "string" || !body.runId.trim())) {
      throw await monidHttpError(response, "Could not start the capability.");
    }
    let run: MonidRun;
    try {
      run = parseMonidRun(body);
    } catch (error) {
      const runId = isRecord(body) && typeof body.runId === "string" ? body.runId.trim() : "";
      if (error instanceof MonidApiError && runId) {
        throw new MonidApiError(error.message, error.status, {
          runId,
          async: response.status === 202,
        });
      }
      throw error;
    }
    return { async: response.status === 202, httpStatus: response.status, run };
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<MonidRun> {
    const response = await this.#request(`/v1/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await monidHttpError(response, "Could not check capability status.");
    return parseMonidRun(await readJson(response));
  }

  async stopRun(runId: string, signal?: AbortSignal): Promise<MonidRun> {
    const response = await this.#request(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      ...(signal ? { signal } : {}),
    });
    const body = await readJson(response);
    if (!response.ok && response.status !== 409) {
      throw await monidHttpError(response, "Could not stop the capability.");
    }
    return parseMonidRun(body);
  }

  async getWalletBalance(signal?: AbortSignal): Promise<{
    balance: MonidMoney;
    held?: MonidMoney;
  }> {
    const response = await this.#request("/v1/wallet/balance", {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await monidHttpError(response, "Could not read capability balance.");
    const value = await readJson(response);
    if (!isRecord(value)) throw new MonidApiError("Malformed capability wallet response.", 502);
    return {
      balance: parseMonidMoney(value.balance, "balance"),
      ...(value.held === undefined ? {} : { held: parseMonidMoney(value.held, "held") }),
    };
  }

  #request(path: string, init: RequestInit) {
    return this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  }
}

export function isTerminalMonidRun(status: MonidRunStatus) {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "BLOCKED" ||
    status === "STOPPED" ||
    status === "TIMED_OUT"
  );
}

function parseMonidInspection(value: unknown): MonidInspection {
  if (!isRecord(value)) throw new MonidApiError("Malformed capability inspection.", 502);
  const provider = requiredString(value.provider, "inspection provider");
  const endpoint = requiredString(value.endpoint, "inspection endpoint");
  return {
    id: typeof value.id === "string" ? value.id : `${provider}:${endpoint}`,
    provider,
    endpoint,
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.price === undefined ? {} : { price: parseMonidPrice(value.price) }),
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };
}

function parseMonidRun(value: unknown): MonidRun {
  if (!isRecord(value)) throw new MonidApiError("Malformed capability run response.", 502);
  const status = requiredString(value.status, "run status");
  if (!MONID_RUN_STATUSES.has(status as MonidRunStatus)) {
    throw new MonidApiError(`Unknown capability run status ${JSON.stringify(status)}.`, 502);
  }
  const providerResponse = isRecord(value.providerResponse)
    ? {
        ...(typeof value.providerResponse.httpStatus === "number"
          ? { httpStatus: value.providerResponse.httpStatus }
          : {}),
        ...("error" in value.providerResponse ? { error: value.providerResponse.error } : {}),
      }
    : value.providerResponse === null
      ? null
      : undefined;
  return {
    runId: requiredString(value.runId, "run id"),
    provider: requiredString(value.provider, "run provider"),
    endpoint: requiredString(value.endpoint, "run endpoint"),
    status: status as MonidRunStatus,
    ...("output" in value ? { output: value.output } : {}),
    ...(providerResponse !== undefined ? { providerResponse } : {}),
    ...(value.price === undefined ? {} : { price: parseMonidPrice(value.price) }),
    ...(value.cost === undefined || value.cost === null
      ? { cost: null }
      : { cost: parseMonidMoney(value.cost, "run cost") }),
    ...(value.billing === undefined ? {} : { billing: parseMonidBilling(value.billing) }),
    ...(value.billedUnits === undefined
      ? {}
      : { billedUnits: parseNonnegativeNumber(value.billedUnits, "billed units") }),
    ...(value.resultCount === undefined || value.resultCount === null
      ? {}
      : { resultCount: parseNonnegativeInteger(value.resultCount, "result count") }),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.startedAt === "string" || value.startedAt === null
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.completedAt === "string" || value.completedAt === null
      ? { completedAt: value.completedAt }
      : {}),
  };
}

function parseMonidBilling(value: unknown): NonNullable<MonidRun["billing"]> {
  if (!isRecord(value)) throw new MonidApiError("Malformed run billing.", 502);
  return {
    ...(value.calculatedCost === undefined
      ? {}
      : { calculatedCost: parseMonidBillingCost(value.calculatedCost, "calculated cost") }),
    ...(value.actualCost === undefined
      ? {}
      : { actualCost: parseMonidBillingCost(value.actualCost, "actual cost") }),
    ...(value.reportedCost === undefined
      ? {}
      : { reportedCost: parseMonidBillingCost(value.reportedCost, "reported cost") }),
  };
}

function parseMonidBillingCost(
  value: unknown,
  label: string,
): { value: number; unit: string; currency: string } {
  if (
    !isRecord(value) ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    value.value < 0 ||
    typeof value.unit !== "string" ||
    !value.unit.trim() ||
    value.currency !== "USD"
  ) {
    throw new MonidApiError(`Malformed run ${label}.`, 502);
  }
  return { value: value.value, unit: value.unit, currency: "USD" };
}

function parseMonidPrice(value: unknown): MonidPrice {
  if (!isRecord(value)) throw new MonidApiError("Malformed capability price.", 502);
  const amount = parseMonidPriceAmount(value.amount, "price amount");
  const currency =
    value.currency === undefined
      ? amount.currency
      : parseUsdCurrency(value.currency, "price currency");
  if (currency !== amount.currency) {
    throw new MonidApiError("Malformed price currency.", 502);
  }
  return {
    type: requiredString(value.type, "price type"),
    amount: amount.value,
    currency,
    ...(value.flatFee === undefined
      ? {}
      : { flatFee: parseMonidPriceAmount(value.flatFee, "price flat fee").value }),
    ...(Array.isArray(value.notes)
      ? { notes: value.notes.filter((note): note is string => typeof note === "string") }
      : {}),
  };
}

function parseMonidPriceAmount(value: unknown, label: string): { value: number; currency: "USD" } {
  if (isRecord(value)) {
    return {
      value: parseNonnegativeNumber(value.value, label),
      currency: parseUsdCurrency(value.currency, `${label} currency`),
    };
  }
  return {
    value: parseNonnegativeNumber(value, label),
    currency: "USD",
  };
}

function parseNonnegativeNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MonidApiError(`Malformed ${label}.`, 502);
  }
  return value;
}

function parseNonnegativeInteger(value: unknown, label: string) {
  const parsed = parseNonnegativeNumber(value, label);
  if (!Number.isSafeInteger(parsed)) {
    throw new MonidApiError(`Malformed ${label}.`, 502);
  }
  return parsed;
}

function parseUsdCurrency(value: unknown, label: string): "USD" {
  if (value !== "USD") throw new MonidApiError(`Malformed ${label}.`, 502);
  return "USD";
}

function parseMonidMoney(value: unknown, label: string): MonidMoney {
  if (
    !isRecord(value) ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    value.value < 0 ||
    value.currency !== "USD"
  ) {
    throw new MonidApiError(`Malformed ${label}.`, 502);
  }
  return { value: value.value, currency: "USD" };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MonidApiError("Capability provider returned invalid JSON.", response.status || 502);
  }
}

async function monidHttpError(response: Response, fallback: string) {
  // Provider bodies can contain request input. Keep boundary errors generic so
  // credentials and contact identifiers never enter logs or chat messages.
  return new MonidApiError(`${fallback} (HTTP ${response.status || 502}).`, response.status || 502);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new MonidApiError(`Malformed ${label}.`, 502);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const MONID_RUN_STATUSES = new Set<MonidRunStatus>([
  "READY",
  "RUNNING",
  "STOPPING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "STOPPED",
  "TIMED_OUT",
]);
