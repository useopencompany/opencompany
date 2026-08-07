import { describe, expect, it } from "vitest";
import {
  GOAT_BRAIN_SOURCE_REF_MAX_LENGTH,
  isValidBrainSourceRef,
  parseBrainSourceRef,
} from "./schema";

describe("goat brain source refs", () => {
  it("accepts provider:id refs, including ids with colons and slashes", () => {
    expect(isValidBrainSourceRef("gmail:thread_456")).toBe(true);
    expect(isValidBrainSourceRef("jamie:meeting:calendar_event_123")).toBe(true);
    expect(isValidBrainSourceRef("gmail://message/1")).toBe(true);
    expect(isValidBrainSourceRef("linear:issue_ABC-12")).toBe(true);
  });

  it("rejects refs without a provider:id shape", () => {
    expect(isValidBrainSourceRef("manual")).toBe(false);
    expect(isValidBrainSourceRef("Gmail:thread_1")).toBe(false);
    expect(isValidBrainSourceRef("gmail:thread 1")).toBe(false);
    expect(isValidBrainSourceRef("gmail:bad|ref")).toBe(false);
    expect(isValidBrainSourceRef("gmail:")).toBe(false);
    expect(isValidBrainSourceRef(":thread_1")).toBe(false);
    expect(isValidBrainSourceRef(`gmail:${"x".repeat(GOAT_BRAIN_SOURCE_REF_MAX_LENGTH)}`)).toBe(
      false,
    );
  });

  it("parses the provider and provider-scoped id", () => {
    expect(parseBrainSourceRef("jamie:meeting:calendar_event_123")).toEqual({
      raw: "jamie:meeting:calendar_event_123",
      provider: "jamie",
      id: "meeting:calendar_event_123",
    });
    expect(parseBrainSourceRef(" gmail:thread_456 ")).toEqual({
      raw: "gmail:thread_456",
      provider: "gmail",
      id: "thread_456",
    });
    expect(parseBrainSourceRef("manual")).toBeNull();
    expect(parseBrainSourceRef(42)).toBeNull();
  });
});
