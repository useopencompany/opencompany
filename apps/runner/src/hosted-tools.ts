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

type HostedToolHandler = {
  execute: (input: {
    args: unknown;
    env: RunnerEnv;
    enabledTools: RuntimeToolName[];
    signal: AbortSignal;
  }) => HostedToolResult | Promise<HostedToolResult>;
  validateEnvironment?: (env: RunnerEnv) => void;
  failureContext?: (input: { args: unknown; error: unknown }) => Record<string, unknown>;
};

export class MissingEnvError extends Error {
  constructor(
    readonly envName: string,
    message: string,
  ) {
    super(message);
    this.name = "MissingEnvError";
  }
}

export function getHostedToolFailureContext(input: {
  name: RuntimeToolName;
  args: unknown;
  error: unknown;
}): Record<string, unknown> {
  const handler = HOSTED_TOOL_HANDLERS[input.name];
  if (handler?.failureContext) {
    return handler.failureContext({ args: input.args, error: input.error });
  }

  return {
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
  };
}

export async function executeHostedTool(input: {
  name: RuntimeToolName;
  args: unknown;
  env: RunnerEnv;
  enabledTools: RuntimeToolName[];
  signal: AbortSignal;
}): Promise<HostedToolResult> {
  const handler = HOSTED_TOOL_HANDLERS[input.name];
  if (!handler) throw new Error(`Unknown hosted tool: ${input.name}`);
  return handler.execute(input);
}

export function validateHostedToolEnvironment(input: {
  enabledTools: RuntimeToolName[];
  env: RunnerEnv;
}) {
  for (const tool of input.enabledTools) {
    HOSTED_TOOL_HANDLERS[tool]?.validateEnvironment?.(input.env);
  }
}

const HOSTED_TOOL_HANDLERS: Partial<Record<RuntimeToolName, HostedToolHandler>> = {
  tool_help: {
    execute: ({ args, enabledTools }) => executeToolHelp(args, enabledTools),
  },
  exa_search: {
    execute: ({ args, env, signal }) => executeExaSearch(args, env, signal),
    failureContext: ({ args, error }) => getExaSearchFailureContext(args, error),
    validateEnvironment: (env) => {
      if (!env.exaApiKey) {
        throw new MissingEnvError(
          "EXA_API_KEY",
          "The exa_search tool is enabled, but EXA_API_KEY is not configured.",
        );
      }
    },
  },
  web_fetch: {
    execute: ({ args, signal }) => executeWebFetch(args, signal),
    failureContext: () => ({
      hosted_provider: "direct_http",
      hosted_operation: "fetch",
      tool_error_stage: "unknown",
      tool_error_code: "hosted_tool_failed",
    }),
  },
};

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
    throw new MissingEnvError("EXA_API_KEY", "EXA_API_KEY is required for exa_search.");
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

async function executeWebFetch(args: unknown, signal: AbortSignal): Promise<HostedToolResult> {
  const request = buildWebFetchRequest(args);
  const response = await fetch(request.url.toString(), {
    headers: {
      Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
      "User-Agent": "OpenCompanyAgent/0.1 (+https://opencompany.ai)",
    },
    redirect: "follow",
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Web fetch failed (${response.status}): ${response.statusText}`);
  }

  const finalUrl = response.url || request.url.toString();
  const isHtml = /\bhtml\b/i.test(contentType) || looksLikeHtml(body);
  const isText = /^text\//i.test(contentType) || !contentType;
  if (!isHtml && !isText) {
    throw new Error(`Web fetch only supports HTML or text responses, got ${contentType}.`);
  }

  const page = isHtml ? extractHtmlPage(body, finalUrl) : extractTextPage(body);
  const text = truncate(page.text, request.maxCharacters);

  return {
    output: omitUndefined({
      url: request.url.toString(),
      finalUrl,
      status: response.status,
      contentType,
      title: page.title,
      description: page.description,
      text,
      truncated: page.text.length > text.length,
      links: request.includeLinks ? page.links.slice(0, 50) : [],
    }),
    usage: {
      provider: "direct_http",
      operation: "fetch",
      costUsdMicros: 0,
      rawUsage: {
        status: response.status,
        contentType,
        bytesRead: new TextEncoder().encode(body).byteLength,
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

function getExaSearchFailureContext(args: unknown, error: unknown) {
  const record = isRecord(args) ? args : {};
  const category = readOptionalString(record, "category");
  const excludeDomains = readOptionalStringArray(record, "excludeDomains");
  const hasPublishedDateFilter =
    Boolean(readOptionalString(record, "startPublishedDate")) ||
    Boolean(readOptionalString(record, "endPublishedDate"));
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const context: Record<string, unknown> = {
    hosted_provider: "exa",
    hosted_operation: "search",
    tool_error_stage: "unknown",
    tool_error_code: "hosted_tool_failed",
    ...(category ? { exa_category: category } : {}),
    exa_has_exclude_domains: excludeDomains.length > 0,
    exa_has_published_date_filter: hasPublishedDateFilter,
  };

  if (!readOptionalString(record, "query")?.trim()) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_invalid_query",
    };
  }

  if (
    (category === "company" || category === "people") &&
    (excludeDomains.length > 0 || hasPublishedDateFilter)
  ) {
    return {
      ...context,
      tool_error_stage: "request_validation",
      tool_error_code: "exa_unsupported_category_filter_combination",
    };
  }

  if (message.startsWith("EXA_API_KEY") || message.includes("EXA_API_KEY is not configured")) {
    return {
      ...context,
      tool_error_stage: "configuration",
      tool_error_code: "exa_missing_api_key",
    };
  }

  if (message.startsWith("Exa search failed (")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "exa_http_error",
      ...readHttpStatusFromMessage(message),
    };
  }

  if (message.includes("unexpected response shape") || message.includes("non-JSON response")) {
    return {
      ...context,
      tool_error_stage: "provider_response",
      tool_error_code: "exa_malformed_response",
    };
  }

  return context;
}

function readHttpStatusFromMessage(message: string) {
  const match = message.match(/\((\d{3})\)/);
  return match?.[1] ? { provider_status: Number(match[1]) } : {};
}

function buildWebFetchRequest(args: unknown) {
  const record = asRecord(args);
  const rawUrl = readString(record, "url").trim();
  if (!rawUrl) throw new Error("web_fetch url must not be empty.");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch url must be a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports http and https URLs.");
  }

  return {
    url,
    maxCharacters: Math.min(
      Math.max(Math.floor(readOptionalNumber(record, "maxCharacters") ?? 12_000), 1000),
      20_000,
    ),
    includeLinks: readOptionalBoolean(record, "includeLinks") ?? true,
  };
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

function extractHtmlPage(html: string, baseUrl: string) {
  const title = extractTagText(html, "title");
  const description = extractMetaContent(html, ["description", "og:description"]);

  return {
    title: title ? truncate(title, 300) : undefined,
    description: description ? truncate(description, 500) : undefined,
    text: htmlToReadableText(html),
    links: extractLinks(html, baseUrl),
  };
}

function extractTextPage(text: string) {
  return {
    title: undefined,
    description: undefined,
    text: normalizeWhitespace(text),
    links: [] as Array<{ text: string; url: string }>,
  };
}

function looksLikeHtml(text: string) {
  return /<(html|head|body|title|main|article|section|p|a)\b/i.test(text.slice(0, 5000));
}

function extractTagText(html: string, tagName: string) {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)</${escapedTagName}>`, "i"),
  );
  return match ? normalizeWhitespace(decodeHtmlEntities(stripTags(match[1] ?? ""))) : undefined;
}

function extractMetaContent(html: string, names: string[]) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const name = (attrs.name ?? attrs.property ?? "").toLowerCase();
    const content = attrs.content;
    if (content && names.includes(name)) {
      return normalizeWhitespace(decodeHtmlEntities(content));
    }
  }
  return undefined;
}

function extractLinks(html: string, baseUrl: string) {
  const links: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = parseAttributes(match[1] ?? "");
    if (!attrs.href) continue;

    const url = toAbsoluteHttpUrl(attrs.href, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const label = normalizeWhitespace(decodeHtmlEntities(stripTags(match[2] ?? "")));
    links.push({
      text: truncate(label || url, 200),
      url,
    });
    if (links.length >= 100) break;
  }

  return links;
}

function toAbsoluteHttpUrl(rawHref: string, baseUrl: string) {
  const href = decodeHtmlEntities(rawHref).trim();
  if (!href || href.startsWith("#")) return undefined;

  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function htmlToReadableText(html: string) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const withoutHidden = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)\b[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutHidden
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|nav|main|aside|blockquote|pre)>/gi,
      "\n",
    );

  return normalizeWhitespace(decodeHtmlEntities(stripTags(withBreaks)));
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function parseAttributes(tag: string) {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s"'<>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1]?.toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (name) attrs[name] = decodeHtmlEntities(value);
  }
  return attrs;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (_entity, raw: string) => {
      if (raw.startsWith("#x")) {
        const codePoint = Number.parseInt(raw.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
      }
      if (raw.startsWith("#")) {
        const codePoint = Number.parseInt(raw.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
      }

      return (
        {
          amp: "&",
          apos: "'",
          gt: ">",
          lt: "<",
          nbsp: " ",
          quot: '"',
        }[raw.toLowerCase()] ?? `&${raw};`
      );
    })
    .replace(/\u00a0/g, " ");
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
