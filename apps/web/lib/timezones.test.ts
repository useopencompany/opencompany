import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_TIMEZONE,
  normalizeUserTimezone,
  normalizeUserTimezoneSource,
  supportedTimezones,
  timezoneSearchLabel,
} from "./timezones";

describe("user timezones", () => {
  it("normalizes valid IANA timezones and rejects invalid values", () => {
    expect(normalizeUserTimezone(" America/New_York ")).toBe("America/New_York");
    expect(normalizeUserTimezone("Not/AZone")).toBeNull();
    expect(normalizeUserTimezone("")).toBe(DEFAULT_USER_TIMEZONE);
  });

  it("normalizes timezone source values", () => {
    expect(normalizeUserTimezoneSource("browser")).toBe("browser");
    expect(normalizeUserTimezoneSource("manual")).toBe("manual");
    expect(normalizeUserTimezoneSource("bad")).toBe("unset");
  });

  it("returns searchable timezone labels", () => {
    expect(supportedTimezones()).toContain(DEFAULT_USER_TIMEZONE);
    expect(timezoneSearchLabel("America/Los_Angeles")).toBe("America Los Angeles");
  });
});
