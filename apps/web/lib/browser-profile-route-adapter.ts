// Temporary rollback/cached-client bridge for the retired web-owned browser
// profile routes. Authorization, ownership checks, Browserbase access, and
// persistence live exclusively in the canonical API; these adapters forward the
// caller's credentials to `/v1/browser-profiles*` and re-map the typed
// envelopes onto the legacy response shapes already-loaded clients expect.
// Removal signal: the #1203 compatibility observation-window closure.

const LEGACY_ERROR_STATUS = 400;

export async function legacyListBrowserProfiles(request: Request): Promise<Response> {
  const result = await forwardBrowserProfileRequest(request, "/v1/browser-profiles");
  if (result.kind !== "json") return result.response;
  return legacyJson(result, { profiles: result.body.data ?? [] });
}

export async function legacyCreateBrowserProfile(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; url?: unknown };
  const result = await forwardBrowserProfileRequest(request, "/v1/browser-profiles", {
    method: "POST",
    body: {
      name: typeof body.name === "string" ? body.name : "",
      url: typeof body.url === "string" ? body.url : "",
    },
  });
  if (result.kind !== "json") return result.response;
  return legacyJson(result, { profile: result.body.data }, 201);
}

export async function legacyDeleteBrowserProfile(
  request: Request,
  profileId: string,
): Promise<Response> {
  const result = await forwardBrowserProfileRequest(
    request,
    `/v1/browser-profiles/${encodeURIComponent(profileId)}`,
    { method: "DELETE" },
  );
  if (result.kind !== "json") return result.response;
  return legacyJson(result, { ok: true });
}

export async function legacyCreateBrowserProfileLoginSession(
  request: Request,
  profileId: string,
): Promise<Response> {
  const result = await forwardBrowserProfileRequest(
    request,
    `/v1/browser-profiles/${encodeURIComponent(profileId)}/login-sessions`,
    { method: "POST" },
  );
  if (result.kind !== "json") return result.response;
  const data = (result.body.data ?? {}) as { sessionId?: string; liveViewUrl?: string };
  return legacyJson(result, { sessionId: data.sessionId, liveViewUrl: data.liveViewUrl });
}

export async function legacyCompleteBrowserProfileLogin(
  request: Request,
  profileId: string,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    return Response.json({ error: "Could not complete login." }, { status: LEGACY_ERROR_STATUS });
  }
  const result = await forwardBrowserProfileRequest(
    request,
    `/v1/browser-profiles/${encodeURIComponent(profileId)}/login-sessions/${encodeURIComponent(
      sessionId,
    )}/complete`,
    { method: "POST" },
  );
  if (result.kind !== "json") return result.response;
  return legacyJson(result, { ok: true });
}

export async function legacyBrowserProfileLiveView(
  request: Request,
  profileId: string,
): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  const result = await forwardBrowserProfileRequest(
    request,
    `/v1/browser-profiles/${encodeURIComponent(profileId)}/live-view?sessionId=${encodeURIComponent(
      sessionId,
    )}`,
  );
  if (result.kind !== "json") return result.response;
  // A rate-limited upstream is an availability problem, not a dead session;
  // only genuine resolution failures keep the legacy 404 contract.
  if (result.status === 429) {
    return Response.json({ error: "The canonical API is unavailable." }, { status: 503 });
  }
  if (!result.upstreamOk) return new Response(null, { status: 404 });
  const data = (result.body.data ?? {}) as { url?: string };
  if (!data.url) return new Response(null, { status: 404 });
  return withForwardedCookies(result, Response.redirect(data.url, 302));
}

type ForwardResult =
  | {
      kind: "json";
      upstreamOk: boolean;
      status: number;
      body: { data?: unknown; error?: { message?: unknown } };
      setCookies: string[];
    }
  | { kind: "unauthenticated"; response: Response }
  | { kind: "unavailable"; response: Response };

async function forwardBrowserProfileRequest(
  request: Request,
  pathWithQuery: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ForwardResult> {
  const origin = apiOrigin();
  if (!origin) {
    return {
      kind: "unavailable",
      response: Response.json({ error: "The canonical API is unavailable." }, { status: 503 }),
    };
  }
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const browserOrigin = request.headers.get("origin");
  const requestId = request.headers.get("x-request-id");
  if (cookie) headers.set("Cookie", cookie);
  if (authorization) headers.set("Authorization", authorization);
  if (browserOrigin) headers.set("Origin", browserOrigin);
  if (requestId) headers.set("X-Request-Id", requestId);
  headers.set("X-Forwarded-Host", new URL(request.url).host);
  headers.set("X-Forwarded-Proto", new URL(request.url).protocol.slice(0, -1));
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  let upstream: Response;
  try {
    upstream = await fetch(new URL(pathWithQuery, `${origin}/`), {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
    });
  } catch {
    return {
      kind: "unavailable",
      response: Response.json({ error: "The canonical API is unavailable." }, { status: 503 }),
    };
  }

  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  if (upstream.status === 401) {
    return {
      kind: "unauthenticated",
      response: applyCookies(new Response(null, { status: 401 }), setCookies),
    };
  }
  const body = (await upstream.json().catch(() => ({}))) as {
    data?: unknown;
    error?: { message?: unknown };
  };
  return { kind: "json", upstreamOk: upstream.ok, status: upstream.status, body, setCookies };
}

function legacyJson(
  result: Extract<ForwardResult, { kind: "json" }>,
  successBody: unknown,
  successStatus = 200,
) {
  if (!result.upstreamOk) {
    const message =
      typeof result.body.error?.message === "string"
        ? result.body.error.message
        : "The request could not be completed.";
    return applyCookies(
      Response.json({ error: message }, { status: LEGACY_ERROR_STATUS }),
      result.setCookies,
    );
  }
  return applyCookies(Response.json(successBody, { status: successStatus }), result.setCookies);
}

function withForwardedCookies(
  result: Extract<ForwardResult, { kind: "json" }>,
  response: Response,
) {
  return applyCookies(response, result.setCookies);
}

function applyCookies(response: Response, setCookies: string[]) {
  if (!setCookies.length) return response;
  const withCookies = new Response(response.body, response);
  for (const cookie of setCookies) withCookies.headers.append("Set-Cookie", cookie);
  return withCookies;
}

function apiOrigin() {
  const value = process.env.OPENCOMPANY_API_ORIGIN?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  return url.origin;
}
