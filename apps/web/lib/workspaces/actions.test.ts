import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWorkspace } from "@/lib/auth";
import { updateWorkspaceName } from "./actions";

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

describe("updateWorkspaceName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects empty names without touching the database", async () => {
    const result = await updateWorkspaceName("   ");

    expect(result).toEqual({ ok: false, error: "Name cannot be empty." });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("updates only the current workspace", async () => {
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    getDbMock.mockReturnValue({ update } as never);
    getCurrentWorkspaceMock.mockResolvedValue({
      workspace: { id: "wks_123", name: "Old workspace" },
    } as never);

    const result = await updateWorkspaceName("  New workspace  ");

    expect(result).toEqual({ ok: true, name: "New workspace" });
    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      name: "New workspace",
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalledOnce();
  });
});
