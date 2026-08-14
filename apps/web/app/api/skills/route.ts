import { createOpenCompanyClient, type ErrorEnvelope } from "@opencompany/protocol";

// Temporary read-only compatibility adapter. First-party callers use /v1/skills/catalog directly;
// retain this browser URL through the Skills rollback window for older deployed clients.
export async function GET(request: Request) {
  const connection = compatibilityClient(request);
  if (!connection) {
    return Response.json({ error: "The Skill API is unavailable." }, { status: 503 });
  }
  const response = await connection.client.v1.skills.catalog.$get();
  if (!response.ok) return compatibilityError(response, connection.responseHeaders);
  return Response.json(
    { skills: (await response.json()).data },
    { headers: connection.responseHeaders },
  );
}

function compatibilityClient(request: Request) {
  const origin = configuredApiOrigin(process.env.GOAT_API_ORIGIN);
  if (!origin) return null;
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const browserOrigin = request.headers.get("origin");
  const responseHeaders = new Headers({ "Cache-Control": "private, no-store" });
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("Cookie", cookie);
    if (authorization) headers.set("Authorization", authorization);
    if (browserOrigin) headers.set("Origin", browserOrigin);
    const response = await globalThis.fetch(input, { ...init, headers, cache: "no-store" });
    const refreshedCookie = response.headers.get("set-cookie");
    if (refreshedCookie) responseHeaders.set("Set-Cookie", refreshedCookie);
    return response;
  };
  return { client: createOpenCompanyClient(origin, { fetch: fetchWithActor }), responseHeaders };
}

function configuredApiOrigin(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function compatibilityError(response: Response, headers: Headers) {
  const body = (await response.json().catch(() => null)) as ErrorEnvelope | null;
  return Response.json(
    { error: body?.error.message ?? "Skill catalog request failed." },
    { status: response.status, headers },
  );
}
