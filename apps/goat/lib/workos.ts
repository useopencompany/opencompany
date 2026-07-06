export function getGoatAppUrl() {
  return (
    process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3002"
  ).replace(/\/+$/, "");
}

export function getGoatWorkOSRedirectUri() {
  return (
    process.env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    process.env.WORKOS_REDIRECT_URI?.trim() ||
    `${getGoatAppUrl()}/auth/callback`
  );
}
