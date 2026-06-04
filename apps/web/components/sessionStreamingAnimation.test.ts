import { describe, expect, it } from "vitest";
import { revealStep, shouldAnimateStreamingAppend } from "@/components/sessionStreamingAnimation";

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

describe("revealStep", () => {
  it("reveals nothing once the display has caught up", () => {
    expect(revealStep(0)).toBe(0);
    expect(revealStep(-5)).toBe(0);
  });

  it("reveals at least one character while behind", () => {
    expect(revealStep(1)).toBe(1);
    expect(revealStep(9)).toBe(1);
  });

  it("drains a larger backlog faster so display never lags far behind", () => {
    expect(revealStep(90)).toBe(10);
    expect(revealStep(900)).toBe(100);
    expect(revealStep(45)).toBeGreaterThan(revealStep(9));
  });
});
