"use client";

const SESSION_BRIDGE_PATH = "/api/auth/share-api-session";

let sessionPreparation: { key: string; promise: Promise<void> } | null = null;

export function headlessChatApiBaseUrl(
  configured = process.env.NEXT_PUBLIC_GOAT_API_ORIGIN,
  fallback = headlessChatWebBaseUrl(),
) {
  if (!configured?.trim()) {
    if (!fallback) throw new Error("The canonical Chat API base URL is unavailable.");
    return parseHttpOrigin(fallback, "web fallback");
  }
  return parseHttpOrigin(configured, "NEXT_PUBLIC_GOAT_API_ORIGIN");
}

export function headlessChatWebBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim() ?? "";
}

export function createHeadlessChatApiFetch(
  options: {
    baseUrl?: string;
    webBaseUrl?: string;
    fetch?: typeof globalThis.fetch;
    prepareSession?: boolean;
  } = {},
): typeof globalThis.fetch {
  const apiOrigin = parseHttpOrigin(options.baseUrl ?? headlessChatApiBaseUrl(), "API base URL");
  const webOrigin = parseHttpOrigin(
    options.webBaseUrl ?? (headlessChatWebBaseUrl() || apiOrigin),
    "web base URL",
  );
  const fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis);
  const prepareSession = options.prepareSession ?? typeof window !== "undefined";

  return async (input, init) => {
    if (prepareSession && apiOrigin !== webOrigin) {
      await prepareBrowserSession({ apiOrigin, webOrigin, fetch: fetchImpl });
    }
    return fetchImpl(input, { ...init, credentials: "include" });
  };
}

export function invalidateHeadlessChatApiSession() {
  sessionPreparation = null;
}

async function prepareBrowserSession(input: {
  apiOrigin: string;
  webOrigin: string;
  fetch: typeof globalThis.fetch;
}) {
  const key = `${input.webOrigin}->${input.apiOrigin}`;
  if (sessionPreparation?.key !== key) {
    const promise = shareBrowserSession(input);
    sessionPreparation = { key, promise };
  }
  try {
    await sessionPreparation.promise;
  } catch (error) {
    if (sessionPreparation?.key === key) sessionPreparation = null;
    throw error;
  }
}

async function shareBrowserSession(input: { webOrigin: string; fetch: typeof globalThis.fetch }) {
  const response = await input.fetch(new URL(SESSION_BRIDGE_PATH, input.webOrigin), {
    method: "POST",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`The canonical Chat session setup failed with HTTP ${response.status}.`);
  }
}

function parseHttpOrigin(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid HTTP origin.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a valid HTTP origin.`);
  }
  return url.origin;
}
