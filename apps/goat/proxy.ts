import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import { type NextRequest, NextResponse } from "next/server";
import { isInitialDocumentRequest, localGoatHttpsRedirectUrl } from "@/lib/local-https-redirect";
import { getGoatWorkOSRedirectUri } from "@/lib/workos";

const UNAUTHENTICATED_PATHS = new Set(["/auth/callback", "/auth/sign-in", "/api/healthz"]);

export default async function proxy(request: NextRequest) {
  const localHttpsRedirect = localGoatHttpsRedirectUrl(request);
  if (localHttpsRedirect) {
    return NextResponse.redirect(localHttpsRedirect);
  }

  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getGoatWorkOSRedirectUri(),
  });

  if (UNAUTHENTICATED_PATHS.has(request.nextUrl.pathname) || session.user) {
    return handleAuthkitHeaders(request, headers);
  }

  if (!isInitialDocumentRequest(request)) {
    return handleAuthkitHeaders(request, headers);
  }

  return handleAuthkitHeaders(request, headers, {
    redirect: authorizationUrl ?? new URL("/auth/sign-in", request.url).toString(),
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon.svg|icon(?:/.*)?|apple-icon(?:/.*)?).*)",
  ],
};
