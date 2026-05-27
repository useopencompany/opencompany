import { describe, expect, it, vi } from "vitest";
import { githubStatus } from "./status";

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

  it("returns error when not configured", () => {
    expect(
      githubStatus({
        configured: false,
        connectionStatuses: ["connected"],
        availableRepositoryCount: 1,
      }),
    ).toBe("error");
  });

  it("returns not_connected when all connections are disconnected", () => {
    expect(
      githubStatus({
        configured: true,
        connectionStatuses: ["disconnected"],
        availableRepositoryCount: 1,
      }),
    ).toBe("not_connected");
  });

  it("returns needs_repository_access when connected but no available repositories", () => {
    expect(
      githubStatus({
        configured: true,
        connectionStatuses: ["connected"],
        availableRepositoryCount: 0,
      }),
    ).toBe("needs_repository_access");
  });
});
