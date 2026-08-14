import { describe, expect, it } from "vitest";
import { normalizeScheduleDefinition } from "./schedule-rules";

describe("normalizeScheduleDefinition", () => {
  it("uses the existing cron authority and returns one canonical next occurrence", () => {
    expect(
      normalizeScheduleDefinition({
        cron: "  0   9  * * *  ",
        timezone: "UTC",
        now: new Date("2026-08-12T08:00:00.000Z"),
      }),
    ).toEqual({
      cron: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-08-12T09:00:00.000Z"),
    });
  });

  it("rejects invalid cron while preserving the existing UTC timezone fallback", () => {
    expect(
      normalizeScheduleDefinition({
        cron: "0 0 9 * * *",
        timezone: "UTC",
        now: new Date("2026-08-12T08:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      normalizeScheduleDefinition({
        cron: "0 9 * * *",
        timezone: "Not/A_Timezone",
        now: new Date("2026-08-12T08:00:00.000Z"),
      }),
    ).toEqual({
      cron: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-08-12T09:00:00.000Z"),
    });
  });
});
