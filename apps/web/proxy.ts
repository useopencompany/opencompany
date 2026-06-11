import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { type NextRequest, NextResponse } from "next/server";
import { getWorkOSRedirectUri } from "@/lib/workos";

// Next.js 16 renamed Middleware to Proxy; keep this file as proxy.ts.
// https://nextjs.org/docs/app/getting-started/proxy

const SIGN_UP_PATHS = ["/auth/sign-up"];
const GOOGLE_OAUTH_BROKER_HOST = "oauth.opencompany.cloud";
const GOOGLE_OAUTH_BROKER_PATH = "/api/google/callback";

const UNAUTHENTICATED_PATHS = [
  "/",
  "/signin",
  "/signup",
  "/auth/callback",
  "/auth/organization",
  "/auth/sign-in",
  "/auth/sign-up",
  "/changelog",
  "/api/healthz",
  GOOGLE_OAUTH_BROKER_PATH,
  "/api/inngest",
  "/api/stripe/webhook",
];

function isInitialDocumentRequest(request: NextRequest) {
  const accept = request.headers.get("accept") ?? "";
  const isDocumentRequest = accept.includes("text/html");
  const isRscRequest = request.headers.has("RSC") || request.headers.has("Next-Router-State-Tree");
  const isPrefetch =
    request.headers.get("Purpose") === "prefetch" ||
    request.headers.get("Sec-Purpose") === "prefetch" ||
    request.headers.has("Next-Router-Prefetch");

  return isDocumentRequest && !isRscRequest && !isPrefetch;
}

function isUnauthenticatedPath(pathname: string) {
  return (
    UNAUTHENTICATED_PATHS.includes(pathname) ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  );
}

function screenHintFor(pathname: string) {
  return SIGN_UP_PATHS.includes(pathname) ? "sign-up" : "sign-in";
}

export default async function proxy(request: NextRequest) {
  if (
    request.nextUrl.hostname === GOOGLE_OAUTH_BROKER_HOST &&
    request.nextUrl.pathname !== GOOGLE_OAUTH_BROKER_PATH
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  let refreshFailed = false;
  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getWorkOSRedirectUri(),
    screenHint: screenHintFor(request.nextUrl.pathname),
    onSessionRefreshError: () => {
      refreshFailed = true;
    },
  });

  if (isUnauthenticatedPath(request.nextUrl.pathname) || session.user) {
    return handleAuthkitHeaders(request, headers);
  }

  if (!isInitialDocumentRequest(request)) {
    if (refreshFailed) {
      headers.delete("Set-Cookie");
    }

    return handleAuthkitHeaders(request, headers);
  }

  return handleAuthkitHeaders(request, headers, { redirect: authorizationUrl ?? "/auth/sign-in" });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon.svg|icon-traced.svg|brand(?:/.*)?|docs(?:/.*)?).*)",
  ],
};
