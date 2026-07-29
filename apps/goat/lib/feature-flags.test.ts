import { describe, expect, it } from "vitest";
import { goatFeatureFlagsFromUser } from "@/lib/feature-flags";

describe("goatFeatureFlagsFromUser", () => {
  it("defaults background task spawning to off", () => {
    expect(goatFeatureFlagsFromUser({}).taskSpawning).toBe(false);
    expect(goatFeatureFlagsFromUser({ taskSpawningEnabled: null }).taskSpawning).toBe(false);
  });

  it("enables background task spawning only for an explicit true value", () => {
    expect(goatFeatureFlagsFromUser({ taskSpawningEnabled: true }).taskSpawning).toBe(true);
    expect(goatFeatureFlagsFromUser({ taskSpawningEnabled: false }).taskSpawning).toBe(false);
  });
});
