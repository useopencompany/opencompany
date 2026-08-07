export function getAppUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl && !/^\/+$/u.test(appUrl)) {
    return parseAppOrigin(appUrl, "NEXT_PUBLIC_APP_URL");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL is required in production.");
  }

  return parseAppOrigin("http://localhost:3002", "NEXT_PUBLIC_APP_URL");
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
