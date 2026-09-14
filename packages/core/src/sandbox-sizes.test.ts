import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_SIZE,
  isSandboxSize,
  SANDBOX_SIZE_SPEC_LIST,
  SANDBOX_SIZE_SPECS,
  SANDBOX_SIZES,
} from "./sandbox-sizes";

describe("sandbox sizes", () => {
  it("describes every size exactly once, in order", () => {
    expect(SANDBOX_SIZE_SPEC_LIST.map((spec) => spec.size)).toEqual([...SANDBOX_SIZES]);
  });

  // A typo in the table would quietly build a template with the wrong allocation and
  // bill a workspace for a machine it did not pick, so the ordering is asserted.
  it("grows strictly from Small to Large", () => {
    const pairs = SANDBOX_SIZE_SPEC_LIST.slice(1).map((current, index) => ({
      previous: SANDBOX_SIZE_SPEC_LIST[index] as (typeof SANDBOX_SIZE_SPEC_LIST)[number],
      current,
    }));
    for (const { previous, current } of pairs) {
      expect(current.cpuCount).toBeGreaterThan(previous.cpuCount);
      expect(current.memoryMB).toBeGreaterThan(previous.memoryMB);
    }
  });

  // Migration 0276 pins every pre-existing session to `large` because that is the
  // single allocation they were all provisioned on. Changing it here would silently
  // resize sandboxes that are already running.
  it("keeps Large at the allocation existing sessions were provisioned on", () => {
    expect(SANDBOX_SIZE_SPECS.large).toMatchObject({ cpuCount: 8, memoryMB: 16384 });
  });

  it("defaults new sessions to Standard", () => {
    expect(DEFAULT_SANDBOX_SIZE).toBe("standard");
  });

  it("rejects values that are not offered sizes", () => {
    expect(isSandboxSize("standard")).toBe(true);
    expect(isSandboxSize("xlarge")).toBe(false);
    expect(isSandboxSize(undefined)).toBe(false);
  });
});
