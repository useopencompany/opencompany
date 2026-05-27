import { describe, expect, it, vi } from "vitest";
import { githubStatus } from "./actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

describe("githubStatus", () => {
  it("surfaces a needs_reauth sibling before connected", () => {
    expect(
      githubStatus({
        configured: true,
        connectionStatuses: ["connected", "needs_reauth"],
        availableRepositoryCount: 3,
      }),
    ).toBe("needs_reauth");
  });

  it("surfaces a sync_failed sibling before connected", () => {
    expect(
      githubStatus({
        configured: true,
        connectionStatuses: ["connected", "sync_failed"],
        availableRepositoryCount: 3,
      }),
    ).toBe("sync_failed");
  });

  it("reports connected when active connections have available repositories", () => {
    expect(
      githubStatus({
        configured: true,
        connectionStatuses: ["connected"],
        availableRepositoryCount: 1,
      }),
    ).toBe("connected");
  });
});
