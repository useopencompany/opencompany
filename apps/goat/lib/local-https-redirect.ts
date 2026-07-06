const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

type RedirectRequest = {
  headers: Pick<Headers, "get" | "has">;
  nextUrl: Pick<URL, "host" | "hostname" | "pathname" | "protocol" | "search">;
};

export function isInitialDocumentRequest(request: RedirectRequest) {
  const accept = request.headers.get("accept") ?? "";
  const isDocumentRequest = accept.includes("text/html");
  const isRscRequest = request.headers.has("RSC") || request.headers.has("Next-Router-State-Tree");
  const isPrefetch =
    request.headers.get("Purpose") === "prefetch" ||
    request.headers.get("Sec-Purpose") === "prefetch" ||
    request.headers.has("Next-Router-Prefetch");

  return isDocumentRequest && !isRscRequest && !isPrefetch;
}

export function localGoatHttpsRedirectUrl(request: RedirectRequest) {
  if (!isInitialDocumentRequest(request)) return null;

  const configured = (
    process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");
  if (!configured.startsWith("https://localhost")) return null;

  let targetOrigin: URL;
  try {
    targetOrigin = new URL(configured);
  } catch {
    return null;
  }

  const requestHost = request.headers.get("host") ?? request.nextUrl.host;
  if (requestHost === targetOrigin.host) return null;
  if (request.nextUrl.protocol !== "http:") return null;
  if (!LOCAL_HOSTNAMES.has(request.nextUrl.hostname)) return null;

  const redirectUrl = new URL(request.nextUrl.pathname, targetOrigin);
  redirectUrl.search = request.nextUrl.search;
  return redirectUrl;
}
