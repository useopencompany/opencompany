import { describe, expect, it } from "vitest";
import { resolveApiPort } from "./server-port";

describe("resolveApiPort", () => {
  it("uses the conventional local API port by default", () => {
    expect(resolveApiPort({})).toBe(3001);
  });

  it("uses PORT for hosted API origins", () => {
    expect(resolveApiPort({ GOAT_API_ORIGIN: "https://api.opencompany.chat", PORT: "10000" })).toBe(
      10000,
    );
  });

  it("uses an isolated localhost API origin instead of the runner's shared PORT", () => {
    expect(resolveApiPort({ GOAT_API_ORIGIN: "http://localhost:55014", PORT: "55011" })).toBe(
      55014,
    );
  });

  it("rejects an invalid hosted listener port", () => {
    expect(() =>
      resolveApiPort({ GOAT_API_ORIGIN: "https://api.opencompany.chat", PORT: "invalid" }),
    ).toThrow(/integer from 1 to 65535/);
  });
});
