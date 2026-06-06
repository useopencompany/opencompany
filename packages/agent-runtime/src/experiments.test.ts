import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_DEFINITIONS,
  EXPERIMENT_KEYS,
  isExperimentEnabled,
  isExperimentKey,
} from "./experiments";

describe("workspace experiments registry", () => {
  it("has a display definition for every registered key", () => {
    const definitionKeys = EXPERIMENT_DEFINITIONS.map((definition) => definition.key).sort();
    expect(definitionKeys).toEqual(Object.values(EXPERIMENT_KEYS).sort());
  });

  it("recognizes only registered keys", () => {
    expect(isExperimentKey("mcp")).toBe(true);
    expect(isExperimentKey("explore")).toBe(true);
    // Unknown keys (e.g. a removed experiment's leftover rows) must never resolve as a flag.
    expect(isExperimentKey("legacy")).toBe(false);
  });

  it("treats missing or false flags as disabled", () => {
    expect(isExperimentEnabled(undefined, EXPERIMENT_KEYS.explore)).toBe(false);
    expect(isExperimentEnabled({}, EXPERIMENT_KEYS.explore)).toBe(false);
    expect(isExperimentEnabled({ explore: false }, EXPERIMENT_KEYS.explore)).toBe(false);
    expect(isExperimentEnabled({ explore: true }, EXPERIMENT_KEYS.explore)).toBe(true);
  });
});
