export function getGoatAppUrl() {
  return (
    process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3002"
  ).replace(/\/+$/, "");
}

export function getGoatWorkOSRedirectUri() {
  const goatRedirectUri = process.env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (goatRedirectUri) return goatRedirectUri;

  if (process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim()) {
    return `${getGoatAppUrl()}/auth/callback`;
  }

  return (
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim() ||
    process.env.WORKOS_REDIRECT_URI?.trim() ||
    `${getGoatAppUrl()}/auth/callback`
  );
}
