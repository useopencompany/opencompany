import { getAppUrl } from "@/lib/app-url";

export { getAppUrl } from "@/lib/app-url";

export function getWorkOSRedirectUri() {
  const redirectUri = process.env.OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) return redirectUri;

  if (
    process.env.OPENCOMPANY_NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NODE_ENV === "production"
  ) {
    return `${getAppUrl()}/auth/callback`;
  }

  return (
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    process.env.WORKOS_REDIRECT_URI?.trim() ||
    `${getAppUrl()}/auth/callback`
  );
}
