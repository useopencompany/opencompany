import { describe, expect, it } from "vitest";
import { shouldAnimateStreamingAppend } from "@/components/sessionStreamingAnimation";

describe("shouldAnimateStreamingAppend", () => {
  it("animates initial and append-only streaming text", () => {
    expect(shouldAnimateStreamingAppend("", "Hello")).toBe(true);
    expect(shouldAnimateStreamingAppend("Hello", "Hello world")).toBe(true);
  });

  it("does not animate rewrites, deletions, or unchanged content", () => {
    expect(shouldAnimateStreamingAppend("Hello world", "Hello")).toBe(false);
    expect(shouldAnimateStreamingAppend("Hello", "Hi there")).toBe(false);
    expect(shouldAnimateStreamingAppend("Hello", "Hello")).toBe(false);
  });
});
