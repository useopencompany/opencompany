import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";
import { getGoatWorkOSRedirectUri } from "@/lib/workos";

const UNAUTHENTICATED_PATHS = new Set(["/auth/callback", "/auth/sign-in", "/api/healthz"]);

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

export default async function proxy(request: NextRequest) {
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
