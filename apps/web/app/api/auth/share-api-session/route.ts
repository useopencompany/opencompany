import { withAuth } from "@workos-inc/authkit-nextjs";
import { headers } from "next/headers";
import { sharedSessionCookieHeaders } from "@/lib/headless-chat-session-cookie";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  if (request.headers.get("origin") !== requestUrl.origin) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  const auth = await withAuth();
  if (!auth.user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const sealedSession = (await headers()).get("x-workos-session");
  if (!sealedSession) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  let cookies: string[];
  try {
    cookies = sharedSessionCookieHeaders({
      name: process.env.WORKOS_COOKIE_NAME?.trim() || "wos-session",
      value: sealedSession,
      configuredDomain: process.env.WORKOS_COOKIE_DOMAIN,
      requestHostname: requestUrl.hostname,
      apiOrigin: process.env.NEXT_PUBLIC_GOAT_API_ORIGIN,
      secure: requestUrl.protocol === "https:",
    });
  } catch {
    return Response.json(
      { error: "Canonical Chat session sharing is not configured." },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers({ "Cache-Control": "private, no-store" });
  for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers: responseHeaders });
}
