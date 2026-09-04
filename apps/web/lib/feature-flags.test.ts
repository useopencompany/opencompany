import { describe, expect, it } from "vitest";
import { featureFlagsFromUser } from "@/lib/feature-flags";

describe("featureFlagsFromUser", () => {
  it("defaults background task spawning to off", () => {
    expect(featureFlagsFromUser({}).taskSpawning).toBe(false);
    expect(featureFlagsFromUser({ taskSpawningEnabled: null }).taskSpawning).toBe(false);
  });

  it("enables background task spawning only for an explicit true value", () => {
    expect(featureFlagsFromUser({ taskSpawningEnabled: true }).taskSpawning).toBe(true);
    expect(featureFlagsFromUser({ taskSpawningEnabled: false }).taskSpawning).toBe(false);
  });

  it("keeps automatic model routing off unless explicitly enabled", () => {
    expect(featureFlagsFromUser({}).autoModelRouting).toBe(false);
    expect(featureFlagsFromUser({ autoModelRoutingEnabled: true }).autoModelRouting).toBe(true);
    expect(featureFlagsFromUser({ autoModelRoutingEnabled: false }).autoModelRouting).toBe(false);
  });

  it("keeps legacy Brain off unless the workspace explicitly enables it", () => {
    expect(featureFlagsFromUser({}).legacyBrain).toBe(false);
    expect(featureFlagsFromUser({ legacyBrainEnabled: null }).legacyBrain).toBe(false);
    expect(featureFlagsFromUser({ legacyBrainEnabled: true }).legacyBrain).toBe(true);
    expect(featureFlagsFromUser({ legacyBrainEnabled: false }).legacyBrain).toBe(false);
  });
});
