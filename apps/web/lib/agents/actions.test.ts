import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWorkspace } from "@/lib/auth";
import { updateAgent } from "./actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspace: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const getCurrentWorkspaceMock = vi.mocked(getCurrentWorkspace);

describe("updateAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates an agent through the current workspace scope", async () => {
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    getDbMock.mockReturnValue({ update } as never);
    getCurrentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123" },
    } as never);

    await updateAgent("agt_123", {
      name: "Research agent",
      content: { type: "doc", content: [] },
    });

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      name: "Research agent",
      content: { type: "doc", content: [] },
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalledOnce();
  });
});
