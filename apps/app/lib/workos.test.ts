import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppUrl, getWorkOSRedirectUri } from "@/lib/workos";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WorkOS URL helpers", () => {
  it("normalizes the configured app URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat/");

    expect(getAppUrl()).toBe("https://my.opencompany.chat");
  });

  it("prefers the explicit redirect URI over the app-URL-derived callback", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat");
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://my.opencompany.chat/auth/custom");

    expect(getWorkOSRedirectUri()).toBe("https://my.opencompany.chat/auth/custom");
  });

  it("derives the callback from the app URL when no redirect URI is set", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat");
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "");

    expect(getWorkOSRedirectUri()).toBe("https://my.opencompany.chat/auth/callback");
  });

  it("fails in production when neither redirect URI nor app URL is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "");

    expect(() => getWorkOSRedirectUri()).toThrow("NEXT_PUBLIC_APP_URL is required in production.");
  });
});
