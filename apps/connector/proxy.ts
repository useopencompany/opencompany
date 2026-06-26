import { authkit, handleAuthkitHeaders } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";
import { getConnectorWorkOSRedirectUri } from "@/lib/workos";

const PUBLIC_PATHS = new Set([
  "/",
  "/auth/callback",
  "/auth/sign-in",
  "/auth/sign-out",
  "/auth/sign-up",
]);

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

function screenHintFor(pathname: string) {
  return pathname === "/auth/sign-up" ? "sign-up" : "sign-in";
}

export default async function proxy(request: NextRequest) {
  const { session, headers, authorizationUrl } = await authkit(request, {
    redirectUri: getConnectorWorkOSRedirectUri(),
    screenHint: screenHintFor(request.nextUrl.pathname),
  });

  if (PUBLIC_PATHS.has(request.nextUrl.pathname) || session.user) {
    return handleAuthkitHeaders(request, headers);
  }

  if (!isInitialDocumentRequest(request)) {
    return handleAuthkitHeaders(request, headers);
  }

  return handleAuthkitHeaders(request, headers, { redirect: authorizationUrl ?? "/auth/sign-in" });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|favicon.svg|icon.svg).*)"],
};
