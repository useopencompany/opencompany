import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getApproval: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ currentUser: mocks.currentUser }));
vi.mock("@opencompany/db/capabilities", () => ({
  getCapabilityApproval: mocks.getApproval,
}));

import { GET } from "./route";

describe("capability approval API", () => {
  beforeEach(() => {
    mocks.currentUser.mockResolvedValue({
      user: { workosUserId: "user_1" },
      workspace: { id: "workspace_1" },
    });
    mocks.getApproval.mockResolvedValue(approvalRow());
  });

  it("loads historical state scoped to the requesting user and workspace", async () => {
    const response = await GET(new Request("https://app.test"), {
      params: Promise.resolve({ runId: "gcr_1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.getApproval).toHaveBeenCalledWith({
      id: "gcr_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    await expect(response.json()).resolves.toMatchObject({
      runId: "gcr_1",
      status: "awaiting_approval",
      maxCostUsdMicros: 360_000,
    });
  });

  it("rejects unauthenticated requests", async () => {
    mocks.currentUser.mockResolvedValueOnce(null);
    const unauthorized = await GET(new Request("https://app.test"), {
      params: Promise.resolve({ runId: "gcr_1" }),
    });
    expect(unauthorized.status).toBe(401);
  });
});

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gcr_1",
    source: "lead",
    action: "lead.find_person_email",
    status: "awaiting_approval",
    quoteTotalCostUsdMicros: 360_000,
    approvalExpiresAt: new Date("2026-07-23T10:15:00.000Z"),
    totalCostUsdMicros: null,
    ...overrides,
  };
}
