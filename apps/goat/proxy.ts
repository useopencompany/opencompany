import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { type NextRequest, NextResponse } from "next/server";
import { isInitialDocumentRequest, localGoatHttpsRedirectUrl } from "@/lib/local-https-redirect";
import { getGoatWorkOSRedirectUri } from "@/lib/workos";

const UNAUTHENTICATED_PATHS = new Set([
  "/auth/callback",
  "/auth/sign-in",
  "/api/healthz",
  "/mcp",
  "/changelog",
]);
const UNAUTHENTICATED_PREFIXES = ["/.well-known/oauth-"];

export default async function proxy(request: NextRequest) {
  const localHttpsRedirect = localGoatHttpsRedirectUrl(request);
  if (localHttpsRedirect) {
    return NextResponse.redirect(localHttpsRedirect);
  }

  if (isLocalAdaptiveToolExposureRequest(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getGoatWorkOSRedirectUri(),
  });

  if (isUnauthenticatedPath(request.nextUrl.pathname) || session.user) {
    return handleAuthkitHeaders(request, headers);
  }

  if (!isInitialDocumentRequest(request)) {
    return handleAuthkitHeaders(request, headers);
  }

  return handleAuthkitHeaders(request, headers, {
    redirect: authorizationUrl ?? new URL("/auth/sign-in", request.url).toString(),
  });
}

function isLocalAdaptiveToolExposureRequest(pathname: string) {
  return (
    process.env.NODE_ENV === "development" &&
    (pathname === "/experiments/adaptive-tool-exposure" ||
      pathname === "/api/experiments/adaptive-tool-exposure")
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon.svg|icon(?:/.*)?|apple-icon(?:/.*)?|manifest\\.webmanifest).*)",
  ],
};

function isUnauthenticatedPath(pathname: string) {
  return (
    UNAUTHENTICATED_PATHS.has(pathname) ||
    UNAUTHENTICATED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
