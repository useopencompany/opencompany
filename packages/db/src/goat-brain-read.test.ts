import { describe, expect, it } from "vitest";
import { resolveGoatBrainSince } from "./goat-brain-read";

describe("resolveGoatBrainSince", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");

  it("resolves short and natural relative windows", () => {
    expect(resolveGoatBrainSince("6h", now).toISOString()).toBe("2026-07-10T06:00:00.000Z");
    expect(resolveGoatBrainSince("2d", now).toISOString()).toBe("2026-07-08T12:00:00.000Z");
    expect(resolveGoatBrainSince("last 3 hours", now).toISOString()).toBe(
      "2026-07-10T09:00:00.000Z",
    );
    expect(resolveGoatBrainSince("4 days", now).toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("accepts ISO timestamps and rejects invalid values", () => {
    expect(resolveGoatBrainSince("2026-07-01T00:00:00.000Z", now).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(() => resolveGoatBrainSince("last week-ish", now)).toThrow(
      'Invalid "since" value: last week-ish',
    );
  });
});
