import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentReferencesForWorkspace } from "./data";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);

describe("loadAgentReferencesForWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only workspace-wide company agents as mentionable references", async () => {
    getDbMock.mockReturnValue(
      dbWithRows([
        { path: "agents/research/research.agent", name: "Research", userId: null },
        { path: "agents/personal/personal.agent", name: "Personal", userId: "usr_123" },
        { path: null, name: "Broken", userId: null },
      ]) as never,
    );

    await expect(loadAgentReferencesForWorkspace("wks_123")).resolves.toEqual([
      { path: "agents/research/research.agent", name: "Research" },
    ]);
  });
});

function dbWithRows(rows: Array<{ path: string | null; name: string; userId: string | null }>) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}
