import { describe, expect, it, vi } from "vitest";
import { claimWikiSourceEvents } from "./wiki-event-claims";

describe("claimWikiSourceEvents", () => {
  it("returns only event keys inserted by the workspace-scoped unique claim", async () => {
    const returning = vi.fn(async () => [{ eventKey: "message:new" }]);
    let insertedValues: unknown;
    let conflictTarget: unknown;
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues = values;
          return {
            onConflictDoNothing: vi.fn((config: unknown) => {
              conflictTarget = config;
              return { returning };
            }),
          };
        }),
      })),
    };

    await expect(
      claimWikiSourceEvents({
        workspaceId: "workspace_1",
        sourceProvider: "slack",
        eventKeys: ["message:existing", "message:new", "message:new"],
        db,
      }),
    ).resolves.toEqual({
      claimedCount: 1,
      claimedEventKeys: ["message:new"],
    });
    expect(insertedValues).toHaveLength(2);
    expect(conflictTarget).toMatchObject({ target: expect.any(Array) });
  });

  it("does not access the database for an empty normalized key set", async () => {
    const db = { insert: vi.fn() };

    await expect(
      claimWikiSourceEvents({
        workspaceId: "workspace_1",
        sourceProvider: "gmail",
        eventKeys: ["", "  "],
        db,
      }),
    ).resolves.toEqual({ claimedCount: 0, claimedEventKeys: [] });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
