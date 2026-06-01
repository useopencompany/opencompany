import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertRunnerDbConfig, toDirectEndpoint } from "./db";

function databaseUrl(host: string, database = "neondb", params = "") {
  return `db://${host}/${database}${params}`;
}

describe("toDirectEndpoint", () => {
  it("strips the -pooler label from a Neon pooled host", () => {
    expect(
      toDirectEndpoint(
        databaseUrl(
          "ep-cool-name-123-pooler.c-3.eu-central-1.aws.neon.tech",
          "neondb",
          "?sslmode=require",
        ),
      ),
    ).toBe(
      databaseUrl("ep-cool-name-123.c-3.eu-central-1.aws.neon.tech", "neondb", "?sslmode=require"),
    );
  });

  it("leaves an already-direct host unchanged", () => {
    const direct = databaseUrl(
      "ep-cool-name-123.c-3.eu-central-1.aws.neon.tech",
      "neondb",
      "?sslmode=require",
    );
    expect(toDirectEndpoint(direct)).toBe(direct);
  });

  it("leaves a non-Neon host unchanged", () => {
    const local = databaseUrl("localhost:5432", "app");
    expect(toDirectEndpoint(local)).toBe(local);
  });
});

describe("assertRunnerDbConfig", () => {
  const original = {
    RUNNER_DATABASE_URL: process.env.RUNNER_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    RUNNER_DB_POOL_MAX: process.env.RUNNER_DB_POOL_MAX,
  };

  beforeEach(() => {
    delete process.env.RUNNER_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.RUNNER_DB_POOL_MAX;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("accepts a DATABASE_URL fallback", () => {
    process.env.DATABASE_URL = databaseUrl("host-pooler.neon.tech", "db");
    expect(() => assertRunnerDbConfig()).not.toThrow();
  });

  it("accepts an explicit RUNNER_DATABASE_URL override", () => {
    process.env.RUNNER_DATABASE_URL = databaseUrl("host.neon.tech", "db");
    expect(() => assertRunnerDbConfig()).not.toThrow();
  });

  it("throws when neither URL is set", () => {
    expect(() => assertRunnerDbConfig()).toThrow(/RUNNER_DATABASE_URL or DATABASE_URL/);
  });

  it("throws on a non-integer pool max", () => {
    process.env.DATABASE_URL = databaseUrl("host.neon.tech", "db");
    process.env.RUNNER_DB_POOL_MAX = "abc";
    expect(() => assertRunnerDbConfig()).toThrow(/RUNNER_DB_POOL_MAX/);
  });

  it("throws on a non-positive pool max", () => {
    process.env.DATABASE_URL = databaseUrl("host.neon.tech", "db");
    process.env.RUNNER_DB_POOL_MAX = "0";
    expect(() => assertRunnerDbConfig()).toThrow(/RUNNER_DB_POOL_MAX/);
  });
});
