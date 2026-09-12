import { describe, expect, it } from "vitest";
import { featureFlagsFromUser } from "@/lib/feature-flags";

describe("featureFlagsFromUser", () => {
  it("defaults past session access off and maps explicit opt-in", () => {
    expect(featureFlagsFromUser({}).pastSessionAccess).toBe(false);
    expect(featureFlagsFromUser({ pastSessionAccessEnabled: null }).pastSessionAccess).toBe(false);
    expect(featureFlagsFromUser({ pastSessionAccessEnabled: true }).pastSessionAccess).toBe(true);
  });

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

  it("keeps sidebar Projects off unless explicitly enabled", () => {
    expect(featureFlagsFromUser({}).sidebarProjects).toBe(false);
    expect(featureFlagsFromUser({ sidebarProjectsEnabled: null }).sidebarProjects).toBe(false);
    expect(featureFlagsFromUser({ sidebarProjectsEnabled: true }).sidebarProjects).toBe(true);
    expect(featureFlagsFromUser({ sidebarProjectsEnabled: false }).sidebarProjects).toBe(false);
  });

  it("keeps subagents off unless the member explicitly enables them", () => {
    expect(featureFlagsFromUser({}).subagents).toBe(false);
    expect(featureFlagsFromUser({ subagentsEnabled: null }).subagents).toBe(false);
    expect(featureFlagsFromUser({ subagentsEnabled: true }).subagents).toBe(true);
    expect(featureFlagsFromUser({ subagentsEnabled: false }).subagents).toBe(false);
  });

  it("keeps legacy Brain off unless the workspace explicitly enables it", () => {
    expect(featureFlagsFromUser({}).legacyBrain).toBe(false);
    expect(featureFlagsFromUser({ legacyBrainEnabled: null }).legacyBrain).toBe(false);
    expect(featureFlagsFromUser({ legacyBrainEnabled: true }).legacyBrain).toBe(true);
    expect(featureFlagsFromUser({ legacyBrainEnabled: false }).legacyBrain).toBe(false);
  });
});
