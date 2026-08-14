const V1_SOURCE = "/v1/:path*";

/**
 * Builds the production CDN route for the canonical Chat API. Invalid or same-origin
 * configuration deliberately leaves the fail-closed App Router handler in control.
 */
export function headlessApiRouting(
  configuredOrigin = process.env.OPENCOMPANY_API_ORIGIN,
  webOrigins = [
    process.env.OPENCOMPANY_NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ],
) {
  const apiOrigin = parseHttpOrigin(configuredOrigin);
  const sameOrigin = webOrigins.some((value) => parseWebOrigin(value) === apiOrigin);
  if (!apiOrigin || sameOrigin) return { headers: [], rewrites: [] };

  return {
    headers: [
      {
        source: V1_SOURCE,
        headers: [{ key: "x-vercel-enable-rewrite-caching", value: "0" }],
      },
    ],
    rewrites: [{ source: V1_SOURCE, destination: `${apiOrigin}/v1/:path*` }],
  };
}

function parseHttpOrigin(value) {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseWebOrigin(value) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return parseHttpOrigin(normalized) ?? parseHttpOrigin(`https://${normalized}`);
}
