import { describe, expect, it } from "vitest";
import { resolveKpiCardValues } from "@/lib/kpis/data";

describe("KPI dashboard data", () => {
  it("falls back to the latest stored value when live fetch fails", () => {
    const result = resolveKpiCardValues(
      { current: null, previous: null, error: "PostHog Query API timed out." },
      [
        { pointAt: new Date("2026-02-07T00:00:00.000Z"), value: "42" },
        { pointAt: new Date("2026-02-06T00:00:00.000Z"), value: "40" },
      ],
    );

    expect(result).toEqual({
      current: 42,
      previous: 40,
      currentIsStale: true,
      stalePointAt: "2026-02-07T00:00:00.000Z",
    });
  });

  it("prefers live values when live fetch succeeds", () => {
    expect(
      resolveKpiCardValues(
        { current: 12, previous: 10, error: null },
        [{ pointAt: new Date("2026-02-07T00:00:00.000Z"), value: "42" }],
      ),
    ).toEqual({
      current: 12,
      previous: 10,
      currentIsStale: false,
      stalePointAt: null,
    });
  });
});
