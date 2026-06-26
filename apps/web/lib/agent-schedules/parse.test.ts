import { describe, expect, it } from "vitest";
import { parseScheduleTriggers } from "./parse";

describe("parseScheduleTriggers", () => {
  const valid = {
    id: "daily-brief",
    cron: "0 9 * * *",
    timezone: "America/New_York",
    prompt: "Send the morning brief.",
    enabled: true,
  };

  it("normalizes a valid routine and keeps its own timezone by default", () => {
    const result = parseScheduleTriggers([valid]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "daily-brief",
          type: "agent.schedule",
          cron: "0 9 * * *",
          timezone: "America/New_York",
          prompt: "Send the morning brief.",
          enabled: true,
        },
      ],
    });
  });

  it("forces a single timezone when one is provided (personal agent inherits the user's tz)", () => {
    const result = parseScheduleTriggers([valid], { timezone: "Europe/Berlin" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.timezone).toBe("Europe/Berlin");
  });

  it("defaults enabled to false unless strictly true", () => {
    const result = parseScheduleTriggers([{ ...valid, enabled: "yes" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.enabled).toBe(false);
  });

  it("rejects an unsupported cron expression", () => {
    const result = parseScheduleTriggers([{ ...valid, cron: "13 7 3 2 5" }]);
    expect(result).toEqual({ ok: false, error: "Routine 1 has an unsupported schedule." });
  });

  it("rejects a missing prompt", () => {
    const result = parseScheduleTriggers([{ ...valid, prompt: "   " }]);
    expect(result).toEqual({ ok: false, error: "Routine 1 needs a prompt." });
  });

  it("rejects a missing id", () => {
    const result = parseScheduleTriggers([{ ...valid, id: "" }]);
    expect(result).toEqual({ ok: false, error: "Routine 1 needs an id." });
  });

  it("rejects duplicate ids", () => {
    const result = parseScheduleTriggers([valid, { ...valid, prompt: "Second." }]);
    expect(result).toEqual({ ok: false, error: 'Duplicate routine id "daily-brief".' });
  });

  it("rejects a non-array input", () => {
    const result = parseScheduleTriggers("nope" as never);
    expect(result).toEqual({ ok: false, error: "Routines must be a list." });
  });
});
