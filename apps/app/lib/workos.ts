import { getGoatAppUrl } from "@/lib/app-url";

export { getGoatAppUrl } from "@/lib/app-url";

export function getGoatWorkOSRedirectUri() {
  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) return redirectUri;

  if (process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NODE_ENV === "production") {
    return `${getGoatAppUrl()}/auth/callback`;
  }

  return process.env.WORKOS_REDIRECT_URI?.trim() || `${getGoatAppUrl()}/auth/callback`;
}
