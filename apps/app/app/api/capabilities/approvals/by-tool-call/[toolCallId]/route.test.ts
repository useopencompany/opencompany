import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  getApproval: vi.fn(),
  getBudget: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ currentUser: mocks.currentUser }));
vi.mock("@opencompany/db/capabilities", () => ({
  getCapabilityApprovalByToolCall: mocks.getApproval,
  getCapabilitySessionBudgetUsdMicros: mocks.getBudget,
}));

import { GET } from "./route";

describe("capability approval by tool call API", () => {
  beforeEach(() => {
    mocks.currentUser.mockResolvedValue({
      user: { workosUserId: "user_1" },
      workspace: { id: "workspace_1" },
    });
    mocks.getApproval.mockResolvedValue({
      id: "gcr_1",
      source: "lead",
      action: "lead.enrich_person",
      status: "awaiting_approval",
      quoteTotalCostUsdMicros: 360_000,
      approvalExpiresAt: new Date("2026-07-23T10:15:00.000Z"),
      totalCostUsdMicros: null,
    });
    mocks.getBudget.mockResolvedValue(250_000);
  });

  it("loads the durable quote and session budget for the owned tool call", async () => {
    const response = await GET(new Request("https://app.test"), {
      params: Promise.resolve({ toolCallId: "tool_1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.getApproval).toHaveBeenCalledWith({
      toolCallId: "tool_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
    });
    await expect(response.json()).resolves.toMatchObject({
      runId: "gcr_1",
      status: "awaiting_approval",
      maxCostUsdMicros: 360_000,
      sessionBudgetUsdMicros: 250_000,
    });
  });
});
