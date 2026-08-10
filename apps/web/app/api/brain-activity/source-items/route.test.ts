import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentGoatUser: vi.fn(),
  getDb: vi.fn(),
  getGoatBrainAccess: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: mocks.currentGoatUser,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  getGoatBrainAccess: mocks.getGoatBrainAccess,
}));

describe("GET /api/brain-activity/source-items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns slim source item metadata for an accessible brain", async () => {
    mocks.currentGoatUser.mockResolvedValue({ user: { workosUserId: "user_member" } });
    mocks.getGoatBrainAccess.mockResolvedValue({ brain: { id: "goat_brain_1" } });
    mocks.getDb.mockReturnValue(sourceItemDbMock([sourceItemRow(), sourceItemRow()]));
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "https://goat.test/api/brain-activity/source-items?brain_ref=goat_brain_1&source_item_ids=gbsrc_1,gbsrc_1",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.getGoatBrainAccess).toHaveBeenCalledWith({
      userWorkosId: "user_member",
      brainRef: "goat_brain_1",
    });
    const body = (await response.json()) as { sourceItems: Array<Record<string, unknown>> };
    expect(body.sourceItems).toHaveLength(1);
    expect(body.sourceItems[0]).toMatchObject({
      id: "gbsrc_1",
      title: "G-57 pricing model follow-up",
      source_provider: "linear",
    });
    expect(body.sourceItems[0]).not.toHaveProperty("raw_payload");
    expect(body.sourceItems[0]).not.toHaveProperty("normalized_payload");
  });

  it("does not return metadata when the brain is not accessible", async () => {
    mocks.currentGoatUser.mockResolvedValue({ user: { workosUserId: "user_member" } });
    mocks.getGoatBrainAccess.mockResolvedValue(null);
    mocks.getDb.mockReturnValue(sourceItemDbMock([sourceItemRow()]));
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "https://goat.test/api/brain-activity/source-items?brain_ref=goat_brain_1&source_item_ids=gbsrc_1",
      ),
    );

    expect(response.status).toBe(404);
  });
});

function sourceItemDbMock(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => rows,
        }),
      }),
    }),
  };
}

function sourceItemRow() {
  const now = new Date("2026-07-09T10:00:00.000Z");
  return {
    id: "gbsrc_1",
    userWorkosId: "user_admin",
    sourceProvider: "linear",
    sourceType: "issue",
    externalId: "G-57",
    title: "G-57 pricing model follow-up",
    occurredAt: now,
    capturedAt: now,
    contentHash: "hash",
    lastIngestJobId: "gbjob_1",
    lastIngestStatus: "succeeded",
    lastIngestError: null,
    lastIngestedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
