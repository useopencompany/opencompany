import { describe, expect, it } from "vitest";
import { normalizeGoatScheduleDefinition } from "./schedule-rules";

describe("normalizeGoatScheduleDefinition", () => {
  it("uses the existing cron authority and returns one canonical next occurrence", () => {
    expect(
      normalizeGoatScheduleDefinition({
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
      normalizeGoatScheduleDefinition({
        cron: "0 0 9 * * *",
        timezone: "UTC",
        now: new Date("2026-08-12T08:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      normalizeGoatScheduleDefinition({
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
