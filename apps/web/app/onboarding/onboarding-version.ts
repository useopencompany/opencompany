import type { NextRequest, NextResponse } from "next/server";

// The technical founder starter setup (ADR 0019) is opt-in while it is tested by hand: a sign-up
// link with ?version=2 turns it on. The query parameter does not survive the WorkOS round-trip, so
// the proxy remembers it in a cookie that the onboarding page reads. ?version=1 switches back.
export const ONBOARDING_VERSION_COOKIE = "goat-onboarding-version";
export const STARTER_SETUP_VERSION = "2";
const LEGACY_VERSION = "1";
const ONBOARDING_VERSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function rememberOnboardingVersion(request: NextRequest, response: NextResponse) {
  const version = request.nextUrl.searchParams.get("version");
  if (version === STARTER_SETUP_VERSION) {
    response.cookies.set(ONBOARDING_VERSION_COOKIE, STARTER_SETUP_VERSION, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      maxAge: ONBOARDING_VERSION_MAX_AGE_SECONDS,
    });
  } else if (version === LEGACY_VERSION) {
    response.cookies.delete(ONBOARDING_VERSION_COOKIE);
  }
  return response;
}

export function usesStarterSetup(input: {
  version: string | undefined;
  cookie: string | undefined;
}) {
  if (input.version === LEGACY_VERSION) return false;
  return input.version === STARTER_SETUP_VERSION || input.cookie === STARTER_SETUP_VERSION;
}
