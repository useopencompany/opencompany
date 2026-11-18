import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(() => ({})),
  neon: vi.fn(() => ({})),
}));

vi.mock("@neondatabase/serverless", () => ({ neon: mocks.neon }));
vi.mock("drizzle-orm/neon-http", () => ({ drizzle: mocks.drizzle }));

import { createDb } from "./client";

describe("createDb", () => {
  beforeEach(() => {
    mocks.drizzle.mockClear();
    mocks.neon.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses API_DATABASE_URL when the API runtime does not ship DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("API_DATABASE_URL", "postgresql://api.example/opencompany");

    createDb();

    expect(mocks.neon).toHaveBeenCalledWith("postgresql://api.example/opencompany");
  });

  it("keeps DATABASE_URL as the default when both runtime variables exist", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://default.example/opencompany");
    vi.stubEnv("API_DATABASE_URL", "postgresql://api.example/opencompany");

    createDb();

    expect(mocks.neon).toHaveBeenCalledWith("postgresql://default.example/opencompany");
  });

  it("keeps an explicitly provided URL ahead of runtime variables", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://default.example/opencompany");
    vi.stubEnv("API_DATABASE_URL", "postgresql://api.example/opencompany");

    createDb("postgresql://explicit.example/opencompany");

    expect(mocks.neon).toHaveBeenCalledWith("postgresql://explicit.example/opencompany");
  });

  it("rejects a missing database URL", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("API_DATABASE_URL", undefined);

    expect(() => createDb()).toThrow(/DATABASE_URL or API_DATABASE_URL/);
  });
});
