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

  it("keeps automatic model routing off unless explicitly enabled", () => {
    expect(goatFeatureFlagsFromUser({}).autoModelRouting).toBe(false);
    expect(goatFeatureFlagsFromUser({ autoModelRoutingEnabled: true }).autoModelRouting).toBe(true);
    expect(goatFeatureFlagsFromUser({ autoModelRoutingEnabled: false }).autoModelRouting).toBe(
      false,
    );
  });

  it("keeps iMessage notifications off unless explicitly enabled", () => {
    expect(goatFeatureFlagsFromUser({}).imessage).toBe(false);
    expect(goatFeatureFlagsFromUser({ imessageEnabled: null }).imessage).toBe(false);
    expect(goatFeatureFlagsFromUser({ imessageEnabled: true }).imessage).toBe(true);
    expect(goatFeatureFlagsFromUser({ imessageEnabled: false }).imessage).toBe(false);
  });
});
