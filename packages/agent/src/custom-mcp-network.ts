import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
privateAddresses.addSubnet("2001::", 23, "ipv6");
privateAddresses.addSubnet("2001:db8::", 32, "ipv6");
privateAddresses.addSubnet("2002::", 16, "ipv6");
privateAddresses.addSubnet("3fff::", 20, "ipv6");

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "set-cookie",
  "origin",
  "referer",
  "content-type",
  "accept",
  "accept-encoding",
  "forwarded",
]);

export class CustomMcpNetworkError extends Error {
  constructor(
    readonly code:
      | "invalid_url"
      | "invalid_headers"
      | "unreachable"
      | "timeout"
      | "redirect"
      | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "CustomMcpNetworkError";
  }
}

export function isPublicMcpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  return (
    family === 6 && globalIpv6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6")
  );
}

export function validateCustomMcpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash)
    throw invalidUrl();
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) && !isPublicMcpAddress(hostname))
  )
    throw invalidUrl();
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|api.?key|authorization|credential|signature/i.test(key)) {
      throw new CustomMcpNetworkError(
        "invalid_url",
        "Put credentials in the authentication fields, not the server URL.",
      );
    }
  }
  return url.toString();
}

export function validateCustomMcpHeaders(value: Record<string, string>): Record<string, string> {
  if (Object.keys(value).length > 12) throw invalidHeaders();
  const headers: Record<string, string> = {};
  for (const [key, secret] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(name) ||
      FORBIDDEN_HEADERS.has(name) ||
      name.startsWith("mcp-") ||
      name.startsWith("x-forwarded-") ||
      name in headers ||
      /[\r\n\0]/.test(secret) ||
      secret.length === 0 ||
      secret.length > 8192
    )
      throw invalidHeaders();
    headers[name] = secret;
  }
  if (JSON.stringify(headers).length > 16_384) throw invalidHeaders();
  return headers;
}

// Resolve and validate on every connection, then pin that exact address to the TLS request.
// The URL hostname is retained for SNI/certificate validation. No global fetch, redirects, proxy,
// or second DNS lookup can turn a public endpoint into an internal request.
export function createCustomMcpFetch(
  endpoint: string,
  secrets: Record<string, string>,
): typeof fetch {
  const expected = validateCustomMcpUrl(endpoint);
  const secretHeaders = validateCustomMcpHeaders(secrets);
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (validateCustomMcpUrl(request.url) !== expected) throw invalidUrl();
    const url = new URL(expected);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await abortableLookup(host, signal);
    if (!addresses.length || addresses.some(({ address }) => !isPublicMcpAddress(address)))
      throw invalidUrl();
    const address = addresses[0]!;
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.length > MAX_REQUEST_BYTES)
      throw new CustomMcpNetworkError("too_large", "The MCP request is too large.");
    const headers = Object.fromEntries(request.headers.entries());
    Object.assign(headers, secretHeaders, { "accept-encoding": "identity" });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const req = httpsRequest(
        url,
        {
          method: request.method,
          headers,
          signal,
          agent: false,
          family: address.family,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(
              new CustomMcpNetworkError(
                "redirect",
                "The MCP endpoint redirects. Enter its final HTTPS URL and test again.",
              ),
            );
            return;
          }
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(response.headers)) {
            if (name === "set-cookie") continue;
            for (const value of Array.isArray(values) ? values : values ? [values] : [])
              responseHeaders.append(name, value);
          }
          let bytes = 0;
          let finished = false;
          const bodyStream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on("data", (chunk: Buffer) => {
                if (finished) return;
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                  response.destroy(
                    new CustomMcpNetworkError(
                      "too_large",
                      "The MCP response exceeded the size limit.",
                    ),
                  );
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) response.pause();
              });
              response.once("end", () => {
                if (!finished) {
                  finished = true;
                  controller.close();
                }
              });
              response.once("error", () => {
                if (!finished) {
                  finished = true;
                  controller.error(
                    new CustomMcpNetworkError(
                      "unreachable",
                      "The MCP response was interrupted or exceeded the size limit.",
                    ),
                  );
                }
              });
            },
            pull() {
              response.resume();
            },
            cancel() {
              finished = true;
              response.destroy();
              req.destroy();
            },
          });
          settled = true;
          resolve(
            new Response(status === 204 || status === 205 || status === 304 ? null : bodyStream, {
              status,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.once("error", () => {
        if (!settled)
          reject(
            signal.aborted
              ? new CustomMcpNetworkError(
                  "timeout",
                  "The MCP server did not respond in time. Try again.",
                )
              : new CustomMcpNetworkError(
                  "unreachable",
                  "Could not reach the MCP server. Check its URL and availability.",
                ),
          );
      });
      req.end(body);
    });
  }) as typeof fetch;
}

async function abortableLookup(hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("DNS lookup aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } catch {
    throw new CustomMcpNetworkError(
      signal.aborted ? "timeout" : "unreachable",
      "Could not resolve the MCP server. Check its URL and try again.",
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function invalidUrl() {
  return new CustomMcpNetworkError(
    "invalid_url",
    "Enter a public HTTPS MCP endpoint. Local and private network addresses are not supported.",
  );
}
function invalidHeaders() {
  return new CustomMcpNetworkError(
    "invalid_headers",
    "Use valid authentication headers. Network, cookie, and MCP protocol headers cannot be overridden.",
  );
}
