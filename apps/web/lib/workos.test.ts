import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppUrl, getWorkOSRedirectUri } from "@/lib/workos";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("opencompany WorkOS URL helpers", () => {
  it("prefers the opencompany app URL over a shared web app URL", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat/");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://my.opencompany.cloud");

    expect(getAppUrl()).toBe("https://my.opencompany.chat");
  });

  it("builds the callback URL from the opencompany app URL before using a shared web callback", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat");
    vi.stubEnv("GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI", "");
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://my.opencompany.cloud/auth/callback");

    expect(getWorkOSRedirectUri()).toBe("https://my.opencompany.chat/auth/callback");
  });

  it("does not use the legacy web callback in production when opencompany is misconfigured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI", "");
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://my.opencompany.cloud/auth/callback");

    expect(() => getWorkOSRedirectUri()).toThrow(
      "GOAT_NEXT_PUBLIC_APP_URL is required for opencompany in production.",
    );
  });
});
