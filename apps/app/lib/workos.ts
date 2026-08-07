import { getAppUrl } from "@opencompany/core/app-url";

export { getAppUrl } from "@opencompany/core/app-url";

export function getWorkOSRedirectUri() {
  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) return redirectUri;

  if (process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NODE_ENV === "production") {
    return `${getAppUrl()}/auth/callback`;
  }

  return process.env.WORKOS_REDIRECT_URI?.trim() || `${getAppUrl()}/auth/callback`;
}
