import { describe, expect, it } from "vitest";
import { filterVectorCandidates, resolveBrainSince } from "./brain-read";

describe("resolveBrainSince", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");

  it("resolves short and natural relative windows", () => {
    expect(resolveBrainSince("6h", now).toISOString()).toBe("2026-07-10T06:00:00.000Z");
    expect(resolveBrainSince("2d", now).toISOString()).toBe("2026-07-08T12:00:00.000Z");
    expect(resolveBrainSince("last 3 hours", now).toISOString()).toBe("2026-07-10T09:00:00.000Z");
    expect(resolveBrainSince("4 days", now).toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("accepts ISO timestamps and rejects invalid values", () => {
    expect(resolveBrainSince("2026-07-01T00:00:00.000Z", now).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(() => resolveBrainSince("last week-ish", now)).toThrow(
      'Invalid "since" value: last week-ish',
    );
  });
});

describe("filterVectorCandidates", () => {
  it("keeps candidates at or under the cutoff and drops the rest", () => {
    const rows = [
      { id: "a", distance: 0.12 },
      { id: "b", distance: 0.8 },
      { id: "c", distance: 0.81 },
      { id: "d", distance: 0.99 },
    ];
    expect(filterVectorCandidates(rows, 0.8)).toEqual([
      { id: "a", distance: 0.12 },
      { id: "b", distance: 0.8 },
    ]);
  });

  it("drops non-finite distances (e.g. an unparseable driver value)", () => {
    const rows = [
      { id: "a", distance: 0.2 },
      { id: "b", distance: Number.NaN },
    ];
    expect(filterVectorCandidates(rows, 0.8)).toEqual([{ id: "a", distance: 0.2 }]);
  });

  it("converts distance into similarity the way the hit does (1 - distance, 4dp)", () => {
    const kept = filterVectorCandidates([{ id: "a", distance: 0.1234 }], 0.8);
    const distance = kept[0]?.distance ?? Number.NaN;
    expect(Number((1 - distance).toFixed(4))).toBe(0.8766);
  });
});
