import { type ErrorEnvelope, PROTOCOL_VERSION } from "@opencompany/protocol";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

export async function proxyHeadlessApiRequest(
  request: Request,
  path: readonly string[],
  options: { apiOrigin?: string; fetch?: typeof globalThis.fetch; basePath?: string } = {},
) {
  const target = headlessApiTarget(request.url, path, options.apiOrigin, options.basePath);
  if (!target) return unavailableResponse(request);
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  headers.set("X-Forwarded-Host", new URL(request.url).host);
  headers.set("X-Forwarded-Proto", new URL(request.url).protocol.slice(0, -1));

  try {
    const upstream = await (options.fetch ?? globalThis.fetch)(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: request.signal,
      // Required by Node's fetch for a streaming request body; ignored by browsers.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const responseHeaders = new Headers(upstream.headers);
    for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);
    responseHeaders.delete("content-encoding");
    responseHeaders.set("Vary", appendVary(responseHeaders.get("Vary"), "Cookie, Authorization"));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return unavailableResponse(request);
  }
}

export function headlessApiTarget(
  requestUrl: string,
  path: readonly string[],
  configuredOrigin = process.env.OPENCOMPANY_API_ORIGIN,
  // Client resources live under /v1; purpose-specific provider ingress (OAuth
  // callbacks, webhooks) relays to top-level API paths instead.
  basePath = "v1",
) {
  const value = configuredOrigin?.trim();
  if (!value) return null;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    return null;
  }
  const incoming = new URL(requestUrl);
  if (origin.origin === incoming.origin) return null;
  const segments = path.map(encodeURIComponent).join("/");
  const target = new URL(
    basePath ? `/${basePath}/${segments}` : `/${segments}`,
    `${origin.origin}/`,
  );
  target.search = incoming.search;
  return target;
}

function unavailableResponse(request: Request) {
  const requestId = request.headers.get("X-Request-Id")?.trim() || crypto.randomUUID();
  return Response.json(
    {
      error: {
        code: "unavailable",
        message: "The Chat API is not available.",
        requestId,
        retryable: true,
      },
      meta: { apiVersion: "v1", protocolVersion: PROTOCOL_VERSION },
    } satisfies ErrorEnvelope,
    { status: 503, headers: { "X-Request-Id": requestId } },
  );
}

function appendVary(current: string | null, value: string) {
  return current ? `${current}, ${value}` : value;
}
