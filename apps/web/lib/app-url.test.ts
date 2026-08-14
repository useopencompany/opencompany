import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppUrl } from "@/lib/app-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAppUrl", () => {
  it("prefers and normalizes the canonical opencompany origin", () => {
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.chat/");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.opencompany.cloud");

    expect(getAppUrl()).toBe("https://opencompany.chat");
  });

  it("does not fall back to the legacy web origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.opencompany.cloud");

    expect(() => getAppUrl()).toThrow(
      "OPENCOMPANY_NEXT_PUBLIC_APP_URL is required for opencompany in production.",
    );
  });

  it.each([
    "https://opencompany.chat/settings?source=env",
    "https://user:password@opencompany.chat",
    "https://opencompany.chat/#fragment",
  ])("rejects a configured value that is not an origin: %s", (value) => {
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", value);

    expect(() => getAppUrl()).toThrow("OPENCOMPANY_NEXT_PUBLIC_APP_URL must be an HTTP(S) origin.");
  });

  it("treats a slash-only production value as missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "///");

    expect(() => getAppUrl()).toThrow(
      "OPENCOMPANY_NEXT_PUBLIC_APP_URL is required for opencompany in production.",
    );
  });

  it("retains the shared origin fallback for local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:4111/");

    expect(getAppUrl()).toBe("http://localhost:4111");
  });
});
