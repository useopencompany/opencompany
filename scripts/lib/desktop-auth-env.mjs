import { randomBytes } from "node:crypto";

export const DESKTOP_AUTH_SECRET_ENV = "OPENCOMPANY_DESKTOP_AUTH_SECRET";

export function isValidDesktopAuthSecret(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return /^[A-Za-z0-9+/]+={0,2}$/.test(key) && Buffer.from(key, "base64").length === 32;
}

export function resolveLocalDesktopAuthSecret(localValue, overrideValue) {
  // A personal override wins at runtime, so repairing the generated file alone
  // cannot fix an invalid override. Leave it intact and explain the conflict.
  if (overrideValue !== undefined) {
    if (!isValidDesktopAuthSecret(overrideValue)) {
      throw new Error(
        `${DESKTOP_AUTH_SECRET_ENV} in .env.override.local must be a base64-encoded 32-byte key. ` +
          "Remove that override to let setup generate a local key, or replace it with a valid key.",
      );
    }
    return overrideValue.trim();
  }

  return isValidDesktopAuthSecret(localValue)
    ? localValue.trim()
    : randomBytes(32).toString("base64");
}
