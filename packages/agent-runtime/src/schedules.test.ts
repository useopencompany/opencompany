import { describe, expect, test } from "vitest";
import {
  cronForSchedulePreset,
  schedulePresetFromCron,
  scheduleSummary,
  scheduleTriggerDueAt,
} from "./schedules";

describe("agent schedules", () => {
  test("generates and parses supported preset cron expressions", () => {
    expect(cronForSchedulePreset({ kind: "minutes", interval: 15 })).toBe("*/15 * * * *");
    expect(cronForSchedulePreset({ kind: "hours", interval: 6 })).toBe("0 */6 * * *");
    expect(cronForSchedulePreset({ kind: "daily", hour: 9, minute: 30 })).toBe("30 9 * * *");
    expect(cronForSchedulePreset({ kind: "weekdays", hour: 9, minute: 0 })).toBe("0 9 * * 1-5");
    expect(cronForSchedulePreset({ kind: "weekly", dayOfWeek: 1, hour: 14, minute: 5 })).toBe(
      "5 14 * * 1",
    );

    expect(schedulePresetFromCron("*/15 * * * *")).toEqual({ kind: "minutes", interval: 15 });
    expect(schedulePresetFromCron("13 9 1 * *")).toBeNull();
  });

  test("summarizes schedules", () => {
    expect(scheduleSummary({ cron: "0 9 * * 1-5", timezone: "UTC" })).toBe("Weekdays at 09:00");
    expect(scheduleSummary({ cron: "5 14 * * 1", timezone: "UTC" })).toBe("Monday at 14:05");
  });

  test("detects due schedules in the configured timezone", () => {
    const scheduledFor = scheduleTriggerDueAt(
      {
        cron: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
        enabled: true,
      },
      new Date("2026-06-01T16:00:12.000Z"),
    );

    expect(scheduledFor?.toISOString()).toBe("2026-06-01T16:00:00.000Z");
    expect(
      scheduleTriggerDueAt(
        {
          cron: "0 9 * * 1-5",
          timezone: "America/Los_Angeles",
          enabled: true,
        },
        new Date("2026-06-01T16:01:00.000Z"),
      ),
    ).toBeNull();
  });
});
