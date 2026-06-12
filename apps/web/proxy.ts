import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { type NextRequest, NextResponse } from "next/server";
import { getWorkOSRedirectUri } from "@/lib/workos";

// Next.js 16 renamed Middleware to Proxy; keep this file as proxy.ts.
// https://nextjs.org/docs/app/getting-started/proxy

const SIGN_UP_PATHS = ["/auth/sign-up"];
// Keep in sync with SKIP_ONBOARDING_COOKIE in lib/auth.ts (not imported to keep the
// proxy bundle free of the db/WorkOS server dependencies).
const SKIP_ONBOARDING_COOKIE = "opencompany-skip-onboarding";
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
    pathname.startsWith("/docs/") ||
    // The oc-bridge daemon's device-code pairing flow: the daemon has no browser session
    // by definition. These routes grant nothing — confirmation happens in the
    // authenticated settings page; see app/api/bridge/pairing/*.
    pathname.startsWith("/api/bridge/pairing/")
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

  // Preview/dev convenience: visiting any URL with ?skipOnboarding persists a cookie that
  // lets lib/auth.ts treat the user as onboarded. Never honored in production (the cookie
  // check in lib/auth.ts is also gated on VERCEL_ENV !== "production").
  const wantsSkipOnboarding =
    request.nextUrl.searchParams.has("skipOnboarding") && process.env.VERCEL_ENV !== "production";

  let refreshFailed = false;
  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getWorkOSRedirectUri(),
    screenHint: screenHintFor(request.nextUrl.pathname),
    onSessionRefreshError: () => {
      refreshFailed = true;
    },
  });

  if (wantsSkipOnboarding) {
    const secure = request.nextUrl.protocol === "https:" ? "; Secure" : "";
    headers.append(
      "Set-Cookie",
      `${SKIP_ONBOARDING_COOKIE}=1; Path=/; Max-Age=604800; SameSite=Lax${secure}`,
    );
  }

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
