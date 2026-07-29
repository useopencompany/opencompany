import { getDb } from "@opencompany/db/client";
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { updateGoatAutoModelRoutingAction } from "@/lib/user-preferences";

const dbMocks = vi.hoisted(() => ({
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("updateGoatAutoModelRoutingAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue({ update: dbMocks.update } as never);
    dbMocks.update.mockReturnValue({ set: dbMocks.set });
    dbMocks.set.mockReturnValue({ where: dbMocks.where });
    dbMocks.where.mockReturnValue({ returning: dbMocks.returning });
    dbMocks.returning.mockResolvedValue([{ autoModelRoutingEnabled: true }]);
    mockCurrentUser(false);
  });

  it("updates the per-user flag and refreshes the app", async () => {
    const result = await updateGoatAutoModelRoutingAction(true);

    expect(result).toEqual({ ok: true, enabled: true });
    expect(dbMocks.set).toHaveBeenCalledWith({
      autoModelRoutingEnabled: true,
      updatedAt: expect.any(Date),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/preferences");
  });

  it("skips the write when the preference already matches", async () => {
    mockCurrentUser(true);

    await expect(updateGoatAutoModelRoutingAction(true)).resolves.toEqual({
      ok: true,
      enabled: true,
    });

    expect(getDb).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

function mockCurrentUser(autoModelRoutingEnabled: boolean) {
  vi.mocked(currentGoatUser).mockResolvedValue({
    user: {
      workosUserId: "user_1",
      autoModelRoutingEnabled,
    },
  } as never);
}
