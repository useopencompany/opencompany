import { describe, expect, it } from "vitest";
import {
  GOAT_BRAIN_SOURCE_REF_MAX_LENGTH,
  isValidGoatBrainSourceRef,
  parseGoatBrainSourceRef,
} from "./schema";

describe("goat brain source refs", () => {
  it("accepts provider:id refs, including ids with colons and slashes", () => {
    expect(isValidGoatBrainSourceRef("gmail:thread_456")).toBe(true);
    expect(isValidGoatBrainSourceRef("jamie:meeting:calendar_event_123")).toBe(true);
    expect(isValidGoatBrainSourceRef("gmail://message/1")).toBe(true);
    expect(isValidGoatBrainSourceRef("linear:issue_ABC-12")).toBe(true);
  });

  it("rejects refs without a provider:id shape", () => {
    expect(isValidGoatBrainSourceRef("manual")).toBe(false);
    expect(isValidGoatBrainSourceRef("Gmail:thread_1")).toBe(false);
    expect(isValidGoatBrainSourceRef("gmail:thread 1")).toBe(false);
    expect(isValidGoatBrainSourceRef("gmail:bad|ref")).toBe(false);
    expect(isValidGoatBrainSourceRef("gmail:")).toBe(false);
    expect(isValidGoatBrainSourceRef(":thread_1")).toBe(false);
    expect(isValidGoatBrainSourceRef(`gmail:${"x".repeat(GOAT_BRAIN_SOURCE_REF_MAX_LENGTH)}`)).toBe(
      false,
    );
  });

  it("parses the provider and provider-scoped id", () => {
    expect(parseGoatBrainSourceRef("jamie:meeting:calendar_event_123")).toEqual({
      raw: "jamie:meeting:calendar_event_123",
      provider: "jamie",
      id: "meeting:calendar_event_123",
    });
    expect(parseGoatBrainSourceRef(" gmail:thread_456 ")).toEqual({
      raw: "gmail:thread_456",
      provider: "gmail",
      id: "thread_456",
    });
    expect(parseGoatBrainSourceRef("manual")).toBeNull();
    expect(parseGoatBrainSourceRef(42)).toBeNull();
  });
});
