export type ExaSearchType = "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";

export type ExaSearchResult = {
  id?: string;
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  image?: string;
  favicon?: string;
  highlights?: string[];
  summary?: string;
};

export type ExaSearchUsage = {
  provider: "exa";
  operation: "search";
  providerRequestId?: string;
  costUsdMicros: number;
  rawUsage: Record<string, unknown>;
};

export type ExaSearchOutput = {
  requestId?: string;
  searchType: ExaSearchType;
  costDollars: number;
  results: ExaSearchResult[];
};

export type ExaSearchDefaults = {
  type?: ExaSearchType;
  numResults?: number;
};

export type ExaSearchRequest = {
  query: string;
  type: ExaSearchType;
  numResults: number;
  category?:
    | "company"
    | "people"
    | "research paper"
    | "news"
    | "personal site"
    | "financial report";
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  contents: Record<string, unknown>;
};

export async function executeExaSearchRequest(input: {
  apiKey: string;
  args: unknown;
  signal: AbortSignal;
  defaults?: ExaSearchDefaults;
}): Promise<{ output: ExaSearchOutput; usage: ExaSearchUsage }> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("EXA_API_KEY is required for exa_search.");
  }

  const request = buildExaSearchRequest(input.args, input.defaults);
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(request),
    signal: input.signal,
  });

  const body = await readJsonResponse(response, "search");
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`Exa search failed (${response.status}): ${message}`);
  }
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Exa search returned an unexpected response shape.");
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const searchType =
    typeof body.searchType === "string" && isExaSearchType(body.searchType)
      ? body.searchType
      : request.type;
  const costDollars = readCostDollars(body.costDollars);
  const costUsdMicros = Math.round(costDollars * 1_000_000);

  return {
    output: {
      ...(requestId ? { requestId } : {}),
      searchType,
      costDollars,
      results: body.results.map(normalizeExaSearchResult).slice(0, request.numResults),
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

export function buildExaSearchRequest(
  args: unknown,
  defaults: ExaSearchDefaults = {},
): ExaSearchRequest {
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
  ] as const);
  const startPublishedDate = readOptionalString(record, "startPublishedDate");
  const endPublishedDate = readOptionalString(record, "endPublishedDate");
  const includeDomains = readOptionalStringArray(record, "includeDomains");
  const excludeDomains = readOptionalStringArray(record, "excludeDomains");

  if (
    (category === "company" || category === "people") &&
    (excludeDomains.length > 0 || startPublishedDate || endPublishedDate)
  ) {
    throw new Error(
      "Exa company and people category searches do not support excludeDomains or published date filters.",
    );
  }
  if (category === "people" && includeDomains.some((domain) => !isLinkedInDomain(domain))) {
    throw new Error("Exa people category searches only support LinkedIn includeDomains.");
  }

  const numResults = Math.min(
    Math.max(Math.floor(readOptionalNumber(record, "numResults") ?? defaults.numResults ?? 5), 1),
    10,
  );
  const fresh = readOptionalBoolean(record, "fresh") ?? false;
  const contents: Record<string, unknown> = { highlights: true };
  if (fresh) contents.maxAgeHours = 0;

  return {
    query,
    type: readOptionalEnum(record, "type", EXA_SEARCH_TYPES) ?? defaults.type ?? "auto",
    numResults,
    ...(category ? { category } : {}),
    ...(nonEmptyArray(includeDomains) ? { includeDomains: includeDomains } : {}),
    ...(nonEmptyArray(excludeDomains) ? { excludeDomains: excludeDomains } : {}),
    ...(startPublishedDate ? { startPublishedDate } : {}),
    ...(endPublishedDate ? { endPublishedDate } : {}),
    contents,
  };
}

function normalizeExaSearchResult(value: unknown): ExaSearchResult {
  const record = asRecord(value);
  const id = readOptionalString(record, "id");
  const title = readOptionalString(record, "title");
  const url = readOptionalString(record, "url");
  const publishedDate = readOptionalString(record, "publishedDate");
  const author = readOptionalString(record, "author");
  const image = readOptionalString(record, "image");
  const favicon = readOptionalString(record, "favicon");
  const highlights = nonEmptyArray(
    readOptionalStringArray(record, "highlights").map((highlight) => truncate(highlight, 1000)),
  );
  const summary = truncate(readOptionalString(record, "summary") ?? "", 1500) || undefined;

  return {
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    ...(author ? { author } : {}),
    ...(image ? { image } : {}),
    ...(favicon ? { favicon } : {}),
    ...(highlights ? { highlights } : {}),
    ...(summary ? { summary } : {}),
  };
}

async function readJsonResponse(response: Response, operation: string) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Exa ${operation} returned non-JSON response (${response.status}).`);
  }
}

function readCostDollars(value: unknown) {
  if (!isRecord(value)) return 0;
  return readOptionalNumber(value, "total") ?? 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
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

function isLinkedInDomain(domain: string) {
  const normalized = domain.toLowerCase().replace(/^www\./, "");
  return normalized === "linkedin.com" || normalized.endsWith(".linkedin.com");
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

const EXA_SEARCH_TYPES = [
  "auto",
  "fast",
  "instant",
  "deep-lite",
  "deep",
  "deep-reasoning",
] as const satisfies readonly ExaSearchType[];

function isExaSearchType(value: string): value is ExaSearchType {
  return (EXA_SEARCH_TYPES as readonly string[]).includes(value);
}
