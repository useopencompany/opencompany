import { getRuntimeToolHelp, type RuntimeToolName } from "@opencompany/agent-runtime";
import type { RunnerEnv } from "./env";

export type HostedToolUsage = {
  provider: string;
  operation: string;
  providerRequestId?: string;
  costUsdMicros: number;
  rawUsage: Record<string, unknown>;
};

export type HostedToolResult = {
  output: unknown;
  usage?: HostedToolUsage;
};

export async function executeHostedTool(input: {
  name: RuntimeToolName;
  args: unknown;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  signal: AbortSignal;
}): Promise<HostedToolResult> {
  if (input.name === "tool_help") {
    return executeToolHelp(input.args, input.enabledTools);
  }

  if (input.name === "exa_search") {
    return executeExaSearch(input.args, input.env, input.signal);
  }

  throw new Error(`Unknown hosted tool: ${input.name}`);
}

export function validateHostedToolEnvironment(input: {
  enabledTools: RuntimeToolName[];
  env: RunnerEnv;
}) {
  if (input.enabledTools.includes("exa_search") && !input.env.exaApiKey) {
    throw new Error("The exa_search tool is enabled, but EXA_API_KEY is not configured.");
  }
}

function executeToolHelp(args: unknown, enabledTools: RuntimeToolName[]): HostedToolResult {
  const toolName = readString(asRecord(args), "tool");
  const help = getRuntimeToolHelp(toolName, enabledTools);
  if (!help) {
    return {
      output: {
        tool: toolName,
        error: "Tool is not enabled for this session or does not exist.",
        enabledTools,
      },
    };
  }

  return { output: help };
}

async function executeExaSearch(
  args: unknown,
  env: RunnerEnv,
  signal: AbortSignal,
): Promise<HostedToolResult> {
  if (!env.exaApiKey) {
    throw new Error("EXA_API_KEY is required for exa_search.");
  }

  const request = buildExaSearchRequest(args);
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.exaApiKey,
    },
    body: JSON.stringify(request),
    signal,
  });

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`Exa search failed (${response.status}): ${message}`);
  }
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Exa search returned an unexpected response shape.");
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const searchType = typeof body.searchType === "string" ? body.searchType : request.type;
  const costDollars = readCostDollars(body.costDollars);
  const costUsdMicros = Math.round(costDollars * 1_000_000);

  return {
    output: {
      requestId,
      searchType,
      costDollars,
      results: body.results.map(normalizeExaResult).slice(0, request.numResults),
    },
    usage: {
      provider: "exa",
      operation: "search",
      ...(requestId ? { providerRequestId: requestId } : {}),
      costUsdMicros,
      rawUsage: {
        requestId,
        searchType,
        costDollars: isRecord(body.costDollars) ? body.costDollars : {},
      },
    },
  };
}

function buildExaSearchRequest(args: unknown) {
  const record = asRecord(args);
  const query = readString(record, "query").trim();
  if (!query) throw new Error("exa_search query must not be empty.");

  const category = readOptionalEnum(record, "category", [
    "company",
    "people",
    "research paper",
    "news",
    "personal site",
    "financial report",
  ]);
  const startPublishedDate = readOptionalString(record, "startPublishedDate");
  const endPublishedDate = readOptionalString(record, "endPublishedDate");
  const excludeDomains = readOptionalStringArray(record, "excludeDomains");

  if (
    (category === "company" || category === "people") &&
    (excludeDomains.length > 0 || startPublishedDate || endPublishedDate)
  ) {
    throw new Error(
      "Exa company and people category searches do not support excludeDomains or published date filters.",
    );
  }

  const numResults = Math.min(Math.max(readOptionalNumber(record, "numResults") ?? 5, 1), 10);
  const fresh = readOptionalBoolean(record, "fresh") ?? false;
  const contents: Record<string, unknown> = { highlights: true };
  if (fresh) contents.maxAgeHours = 0;

  return omitUndefined({
    query,
    type:
      readOptionalEnum(record, "type", ["auto", "fast", "instant", "deep-lite", "deep"]) ?? "auto",
    numResults,
    category,
    includeDomains: nonEmptyArray(readOptionalStringArray(record, "includeDomains")),
    excludeDomains: nonEmptyArray(excludeDomains),
    startPublishedDate,
    endPublishedDate,
    contents,
  });
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Exa search returned non-JSON response (${response.status}).`);
  }
}

function normalizeExaResult(value: unknown) {
  const record = asRecord(value);
  return omitUndefined({
    title: readOptionalString(record, "title"),
    url: readOptionalString(record, "url"),
    publishedDate: readOptionalString(record, "publishedDate"),
    author: readOptionalString(record, "author"),
    highlights: readOptionalStringArray(record, "highlights").map((highlight) =>
      truncate(highlight, 1000),
    ),
    summary: truncate(readOptionalString(record, "summary") ?? "", 1500) || undefined,
  });
}

function readCostDollars(value: unknown) {
  if (!isRecord(value)) return 0;
  const total = value.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument ${key} must be a string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function nonEmptyArray<T>(value: T[]) {
  return value.length > 0 ? value : undefined;
}

function readOptionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
) {
  const value = record[key];
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}
