import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { type NextRequest, NextResponse } from "next/server";
import { rememberOnboardingVersion } from "@/app/onboarding/onboarding-version";
import { isInitialDocumentRequest, localHttpsRedirectUrl } from "@/lib/local-https-redirect";
import { getWorkOSRedirectUri } from "@/lib/workos";

const UNAUTHENTICATED_PATHS = new Set([
  "/auth/callback",
  "/auth/invite",
  "/auth/sign-in",
  "/signin",
  "/signup",
  "/api/healthz",
  "/api/stripe/webhook",
  "/internal/observability/server-error",
  "/mcp",
  "/changelog",
]);

const AUTH_PAGE_PATHS = new Set(["/signin", "/signup"]);

// `/workflow-avatars/` is fetched by Slack when it renders a workflow post, so it can never be
// behind a session.
const UNAUTHENTICATED_PREFIXES = [
  "/.well-known/oauth-",
  "/share/",
  "/auth/desktop/",
  "/workflow-avatars/",
];

export default async function proxy(request: NextRequest) {
  const localHttpsRedirect = localHttpsRedirectUrl(request);
  if (localHttpsRedirect) {
    return NextResponse.redirect(localHttpsRedirect);
  }

  // Next treats multipart posts to App Router pages as Server Actions, then turns an opaque or
  // mismatched Origin into a 500. Reject those requests before they reach the renderer.
  if (isUntrustedAuthPagePost(request)) {
    return new NextResponse(null, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }

  const { session, headers } = await authkit(request, {
    redirectUri: getWorkOSRedirectUri(),
  });

  if (isUnauthenticatedPath(request.nextUrl.pathname) || session.user) {
    return rememberOnboardingVersion(request, handleAuthkitHeaders(request, headers));
  }

  if (!isInitialDocumentRequest(request)) {
    return handleAuthkitHeaders(request, headers);
  }

  return rememberOnboardingVersion(
    request,
    handleAuthkitHeaders(request, headers, {
      redirect: signInRedirectUrl(request.url).toString(),
    }),
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon.svg|icon(?:/.*)?|apple-icon(?:/.*)?|manifest\\.webmanifest).*)",
  ],
};

export function isUnauthenticatedPath(pathname: string) {
  return (
    UNAUTHENTICATED_PATHS.has(pathname) ||
    UNAUTHENTICATED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function isUntrustedAuthPagePost(
  request: Pick<NextRequest, "headers" | "method" | "nextUrl">,
) {
  if (request.method !== "POST" || !AUTH_PAGE_PATHS.has(request.nextUrl.pathname)) return false;

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  return originHost.toLowerCase() !== requestHost.toLowerCase();
}

export function signInRedirectUrl(requestUrl: string) {
  const current = new URL(requestUrl);
  const signIn = new URL("/signin", current);
  if (current.pathname === "/integrations/sentry/setup") {
    signIn.searchParams.set("returnPathname", `${current.pathname}${current.search}`);
  }
  return signIn;
}
