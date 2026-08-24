import { describe, expect, it, vi } from "vitest";
import {
  attributeWikiSourceEventClaims,
  claimWikiSourceEvents,
  listWikiSourceEventClaimedWorkspaceIds,
} from "./wiki-event-claims";

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

describe("wiki source event claim routing", () => {
  it("returns the routed workspaces that already claimed an event", async () => {
    const where = vi.fn(async () => [
      { workspaceId: "workspace_1" },
      { workspaceId: "workspace_2" },
    ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };

    await expect(
      listWikiSourceEventClaimedWorkspaceIds({
        workspaceIds: ["workspace_1", "workspace_2", "workspace_3"],
        sourceProvider: "granola",
        eventKey: "note:note_1",
        db,
      }),
    ).resolves.toEqual(new Set(["workspace_1", "workspace_2"]));
    expect(where).toHaveBeenCalledOnce();
  });

  it("attributes a claimed event to the source item that honored it", async () => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };

    await attributeWikiSourceEventClaims({
      workspaceId: "workspace_1",
      sourceProvider: "jamie",
      eventKeys: ["meeting:meeting_1", "meeting:meeting_1"],
      sourceItemId: "gwsrc_1",
      db,
    });

    expect(set).toHaveBeenCalledWith({ sourceItemId: "gwsrc_1" });
    expect(where).toHaveBeenCalledOnce();
  });
});
