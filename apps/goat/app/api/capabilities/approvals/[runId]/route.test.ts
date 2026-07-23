import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getApproval: vi.fn(),
  approve: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ currentGoatUser: mocks.currentUser }));
vi.mock("@opencompany/db/goat-capabilities", () => ({
  getGoatCapabilityApproval: mocks.getApproval,
  approveGoatCapabilityRun: mocks.approve,
  cancelGoatCapabilityRun: mocks.cancel,
}));

import { GET, POST } from "./route";

describe("capability approval API", () => {
  beforeEach(() => {
    mocks.currentUser.mockResolvedValue({
      user: { workosUserId: "user_1" },
      workspace: { id: "workspace_1" },
    });
    mocks.getApproval.mockResolvedValue(approvalRow());
    mocks.approve.mockResolvedValue(approvalRow({ status: "approved" }));
    mocks.cancel.mockResolvedValue(approvalRow({ status: "canceled" }));
  });

  it("loads historical state scoped to the requesting user and workspace", async () => {
    const response = await GET(new Request("https://goat.test"), {
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

  it("approves once or cancels only the owned row", async () => {
    const approved = await POST(
      new Request("https://goat.test", {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params: Promise.resolve({ runId: "gcr_1" }) },
    );
    expect(approved.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith({
      id: "gcr_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });

    const canceled = await POST(
      new Request("https://goat.test", {
        method: "POST",
        body: JSON.stringify({ decision: "cancel" }),
      }),
      { params: Promise.resolve({ runId: "gcr_1" }) },
    );
    expect(canceled.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith({
      id: "gcr_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
  });

  it("rejects unauthenticated and invalid decisions", async () => {
    mocks.currentUser.mockResolvedValueOnce(null);
    const unauthorized = await GET(new Request("https://goat.test"), {
      params: Promise.resolve({ runId: "gcr_1" }),
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await POST(
      new Request("https://goat.test", {
        method: "POST",
        body: JSON.stringify({ decision: "approve_forever" }),
      }),
      { params: Promise.resolve({ runId: "gcr_1" }) },
    );
    expect(invalid.status).toBe(400);
  });
});

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gcr_1",
    source: "lead",
    action: "lead.enrich_person",
    status: "awaiting_approval",
    quoteTotalCostUsdMicros: 360_000,
    approvalExpiresAt: new Date("2026-07-23T10:15:00.000Z"),
    totalCostUsdMicros: null,
    ...overrides,
  };
}
