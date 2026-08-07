import type { WebFetchToolInput, WebFetchToolOutput } from "./chat-ui";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const WEB_FETCH_MAX_CHARACTERS = 20_000;
const WEB_FETCH_MAX_AGE_HOURS = 24;

// A known-URL fetch is intentionally separate from web search. Exa Contents
// gives chat reliable extraction for dynamic pages, PDFs, and complex layouts
// without exposing the Goat server to arbitrary outbound URLs.
export async function executeGoatChatExaFetch(input: {
  toolInput: WebFetchToolInput;
  apiKey: string;
  signal: AbortSignal;
}): Promise<Extract<WebFetchToolOutput, { ok: true }>> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("EXA_API_KEY is required for web_fetch.");
  }

  const url = normalizePublicWebUrl(input.toolInput.url);
  const response = await fetch(EXA_CONTENTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      urls: [url],
      text: { maxCharacters: WEB_FETCH_MAX_CHARACTERS },
      maxAgeHours: WEB_FETCH_MAX_AGE_HOURS,
      livecrawlTimeout: 15_000,
    }),
    signal: input.signal,
  });

  const body = await readJsonResponse(response);
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText;
    throw new Error(`Web fetch failed (${response.status}): ${message}`);
  }
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error("Web fetch returned an unexpected response shape.");
  }

  const result = body.results.find(isRecord);
  if (!result || typeof result.text !== "string" || !result.text.trim()) {
    throw new Error(contentFailureMessage(body.statuses));
  }

  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  const resultUrl = normalizeResultUrl(result.url, url);
  const text = result.text.trim().slice(0, WEB_FETCH_MAX_CHARACTERS);
  const title = readOptionalString(result, "title");
  const author = readOptionalString(result, "author");
  const publishedDate = readOptionalString(result, "publishedDate");

  return {
    ok: true,
    url: resultUrl,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(publishedDate ? { publishedDate } : {}),
    text,
    ...(result.text.trim().length > text.length ? { truncated: true } : {}),
    ...(requestId ? { requestId } : {}),
    costUsdMicros: costUsdMicros(body.costDollars),
  };
}

export function normalizePublicWebUrl(rawUrl: string) {
  const value = rawUrl.trim();
  if (!value) throw new Error("web_fetch url must not be empty.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("web_fetch url must be a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports http and https URLs.");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch does not support URLs containing credentials.");
  }

  url.hash = "";
  return url.toString();
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Web fetch returned a non-JSON response (${response.status}).`);
  }
}

function contentFailureMessage(statuses: unknown) {
  if (!Array.isArray(statuses)) return "Web fetch returned no readable page content.";
  const status = statuses.find(isRecord);
  if (!status) return "Web fetch returned no readable page content.";

  const error = status.error;
  if (typeof error === "string" && error.trim()) {
    return `Web fetch returned no readable page content: ${error.trim()}`;
  }
  if (isRecord(error)) {
    const httpStatusCode =
      typeof error.httpStatusCode === "number" ? error.httpStatusCode : undefined;
    const tag = readOptionalString(error, "tag");
    const detail = [httpStatusCode ? `HTTP ${httpStatusCode}` : undefined, tag]
      .filter(Boolean)
      .join(" ");
    if (detail) return `Web fetch returned no readable page content (${detail}).`;
  }
  return "Web fetch returned no readable page content.";
}

function normalizeResultUrl(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  try {
    return normalizePublicWebUrl(value);
  } catch {
    return fallback;
  }
}

function costUsdMicros(value: unknown) {
  if (!isRecord(value)) return 0;
  const total = value.total;
  return typeof total === "number" && Number.isFinite(total)
    ? Math.max(0, Math.round(total * 1_000_000))
    : 0;
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
