export function getGoatAppUrl() {
  const goatAppUrl = process.env.GOAT_NEXT_PUBLIC_APP_URL?.trim();
  if (goatAppUrl && !/^\/+$/u.test(goatAppUrl)) {
    return parseAppOrigin(goatAppUrl, "GOAT_NEXT_PUBLIC_APP_URL");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("GOAT_NEXT_PUBLIC_APP_URL is required for Goat in production.");
  }

  return parseAppOrigin(
    process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3002",
    "NEXT_PUBLIC_APP_URL",
  );
}

function parseAppOrigin(value: string, envName: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${envName} must be an HTTP(S) origin.`);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`${envName} must be an HTTP(S) origin.`);
  }
  return url.origin;
}
