import { afterEach, describe, expect, it, vi } from "vitest";
import { getGoatAppUrl, getGoatWorkOSRedirectUri } from "@/lib/workos";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Goat WorkOS URL helpers", () => {
  it("prefers the Goat app URL over a shared web app URL", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat/");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://my.opencompany.cloud");

    expect(getGoatAppUrl()).toBe("https://my.opencompany.chat");
  });

  it("builds the callback URL from the Goat app URL before using a shared web callback", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://my.opencompany.chat");
    vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://my.opencompany.cloud/auth/callback");

    expect(getGoatWorkOSRedirectUri()).toBe("https://my.opencompany.chat/auth/callback");
  });
});
