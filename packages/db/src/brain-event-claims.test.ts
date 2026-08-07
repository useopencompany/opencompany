import { describe, expect, it, vi } from "vitest";
import { claimGoatBrainSourceEvents } from "./brain-event-claims";

describe("claimGoatBrainSourceEvents", () => {
  it("returns the exact provider event keys inserted by the unique claim", async () => {
    const returning = vi.fn(async () => [{ eventKey: "message:new" }]);
    let insertedValues: unknown;
    const values = vi.fn((nextValues: unknown) => {
      insertedValues = nextValues;
      return {
        onConflictDoNothing: vi.fn(() => ({ returning })),
      };
    });
    const db = { insert: vi.fn(() => ({ values })) };

    await expect(
      claimGoatBrainSourceEvents({
        brainRef: "brain_123",
        sourceProvider: "slack",
        eventKeys: ["message:existing", "message:new", "message:new"],
        db,
      }),
    ).resolves.toEqual({
      claimedCount: 1,
      claimedEventKeys: ["message:new"],
    });
    expect(insertedValues).toHaveLength(2);
  });

  it("does not access the database for an empty normalized key set", async () => {
    const db = { insert: vi.fn() };

    await expect(
      claimGoatBrainSourceEvents({
        brainRef: "brain_123",
        sourceProvider: "gmail",
        eventKeys: ["", "  "],
        db,
      }),
    ).resolves.toEqual({ claimedCount: 0, claimedEventKeys: [] });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
