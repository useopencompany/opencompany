import type { AuthenticationResponse } from "@workos-inc/node";
import { cookies } from "next/headers";

export type GoatAuthMethod = "google" | "magic_link";

const LAST_AUTH_METHOD_COOKIE = "goat-last-auth-method";
const OAUTH_STATE_COOKIE = "goat-oauth-state";

export type GoatOAuthStateCookiePayload = {
  state: string;
  invitationToken?: string;
  returnPathname?: string;
};

function toGoatAuthMethod(
  method: AuthenticationResponse["authenticationMethod"],
): GoatAuthMethod | null {
  if (method === "GoogleOAuth") return "google";
  if (method === "MagicAuth") return "magic_link";
  return null;
}

// WorkOS's hosted AuthKit shows a "last used" badge on sign-in; there is no API for
// it, so we replicate it ourselves with a first-party, browser-scoped cookie.
export async function recordLastGoatAuthMethod(
  method: AuthenticationResponse["authenticationMethod"],
) {
  const goatMethod = toGoatAuthMethod(method);
  if (!goatMethod) return;
  const cookieStore = await cookies();
  cookieStore.set(LAST_AUTH_METHOD_COOKIE, goatMethod, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function readLastGoatAuthMethod(): Promise<GoatAuthMethod | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(LAST_AUTH_METHOD_COOKIE)?.value;
  return value === "google" || value === "magic_link" ? value : null;
}

// Short-lived CSRF cookie for the Google OAuth leg: we generate `state`
// ourselves (rather than going through authkit-nextjs's hosted-only helpers)
// so we can target the GoogleOAuth provider directly instead of WorkOS's picker.
export async function setGoatOAuthStateCookie(payload: GoatOAuthStateCookiePayload) {
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, JSON.stringify(payload), {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
  });
}

export async function consumeGoatOAuthStateCookie(): Promise<GoatOAuthStateCookiePayload | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(OAUTH_STATE_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.state === "string" ? (parsed as GoatOAuthStateCookiePayload) : null;
  } catch {
    return null;
  }
}
