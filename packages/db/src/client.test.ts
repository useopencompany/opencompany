import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDatabaseUrl } from "./client";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDatabaseUrl", () => {
  it("uses the runtime-specific API database URL when DATABASE_URL is absent", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("API_DATABASE_URL", " postgres://api ");
    vi.stubEnv("RUNNER_DATABASE_URL", "postgres://runner");

    expect(resolveDatabaseUrl()).toBe("postgres://api");
  });

  it("uses the runtime-specific runner database URL when other URLs are absent", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("API_DATABASE_URL", "");
    vi.stubEnv("RUNNER_DATABASE_URL", "postgres://runner");

    expect(resolveDatabaseUrl()).toBe("postgres://runner");
  });

  it("keeps an explicit URL ahead of environment defaults", () => {
    vi.stubEnv("DATABASE_URL", "postgres://default");
    vi.stubEnv("API_DATABASE_URL", "postgres://api");

    expect(resolveDatabaseUrl(" postgres://explicit ")).toBe("postgres://explicit");
  });

  it("rejects a missing database URL", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("API_DATABASE_URL", "");
    vi.stubEnv("RUNNER_DATABASE_URL", "");

    expect(() => resolveDatabaseUrl()).toThrow(
      "DATABASE_URL, API_DATABASE_URL, or RUNNER_DATABASE_URL is required for database access.",
    );
  });
});
