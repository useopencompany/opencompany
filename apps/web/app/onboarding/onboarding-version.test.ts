import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_VERSION_COOKIE,
  rememberOnboardingVersion,
  usesStarterSetup,
} from "./onboarding-version";

describe("onboarding version", () => {
  it("remembers ?version=2 from the sign-up link across the auth round-trip", () => {
    const response = rememberOnboardingVersion(
      new NextRequest("https://app.example/signup?version=2"),
      NextResponse.next(),
    );
    const cookie = response.cookies.get(ONBOARDING_VERSION_COOKIE);
    expect(cookie?.value).toBe("2");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  });

  it("clears the opt-in with ?version=1 and ignores other values", () => {
    const cleared = rememberOnboardingVersion(
      new NextRequest("https://app.example/onboarding?version=1"),
      NextResponse.next(),
    );
    expect(cleared.headers.get("set-cookie")).toContain(`${ONBOARDING_VERSION_COOKIE}=;`);

    const untouched = rememberOnboardingVersion(
      new NextRequest("https://app.example/signup?version=3"),
      NextResponse.next(),
    );
    expect(untouched.headers.get("set-cookie")).toBeNull();
  });

  it("uses the starter setup only when opted in", () => {
    expect(usesStarterSetup({ version: undefined, cookie: undefined })).toBe(false);
    expect(usesStarterSetup({ version: "2", cookie: undefined })).toBe(true);
    expect(usesStarterSetup({ version: undefined, cookie: "2" })).toBe(true);
    expect(usesStarterSetup({ version: "1", cookie: "2" })).toBe(false);
  });
});
