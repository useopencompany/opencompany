import { cookies } from "next/headers";

// Short-lived cookie carrying the PKCE code_verifier across the X OAuth
// redirect. X's authorization `state` parameter is capped at 500 characters
// and is bounced back through the browser, so the verifier travels in an
// httpOnly cookie instead — mirrors setGoatOAuthStateCookie in auth-methods.ts.
const PKCE_COOKIE = "goat_x_pkce_verifier";

export async function setGoatXAccountPkceCookie(codeVerifier: string) {
  const cookieStore = await cookies();
  cookieStore.set(PKCE_COOKIE, codeVerifier, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
  });
}

export async function consumeGoatXAccountPkceCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(PKCE_COOKIE)?.value;
  // Must match the path the cookie was set with, or this is a no-op deletion
  // of a different cookie and the original stays consumable.
  cookieStore.delete({ name: PKCE_COOKIE, path: "/" });
  return value?.trim() || null;
}
