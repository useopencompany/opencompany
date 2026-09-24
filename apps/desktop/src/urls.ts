// The remote web app the shell wraps. Defaults to production; `dev`/`dev:local`
// scripts override it via OPENCOMPANY_DESKTOP_APP_URL. Trailing slash is trimmed
// so URL joins are predictable.
export const APP_URL = (
  process.env.OPENCOMPANY_DESKTOP_APP_URL ?? "https://my.opencompany.chat"
).replace(/\/+$/, "");

// Same-origin allowlist for in-window navigation. Anything else opens externally.
export const APP_ORIGIN = new URL(APP_URL).origin;

export function isAppOrigin(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}
