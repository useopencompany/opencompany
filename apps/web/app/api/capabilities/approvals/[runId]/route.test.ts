import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getApproval: vi.fn() }));

vi.mock("@/lib/server-api-client", () => ({
  serverApiClient: vi.fn(async () => ({
    v1: { "capability-approvals": { ":runId": { $get: mocks.getApproval } } },
  })),
}));

import { GET } from "./route";

describe("capability approval URL adapter", () => {
  beforeEach(() => {
    mocks.getApproval.mockResolvedValue(
      Response.json({
        data: {
          runId: "gcr_1",
          source: "lead",
          action: "lead.find_person_email",
          status: "awaiting_approval",
          maxCostUsdMicros: 360_000,
          expiresAt: "2026-07-23T10:15:00.000Z",
          settledCostUsdMicros: null,
        },
      }),
    );
  });

  it("forwards the approval id to the canonical API and preserves the legacy body", async () => {
    const response = await GET(new Request("https://opencompany.test"), {
      params: Promise.resolve({ runId: "gcr_1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.getApproval).toHaveBeenCalledWith({ param: { runId: "gcr_1" } });
    await expect(response.json()).resolves.toMatchObject({
      runId: "gcr_1",
      status: "awaiting_approval",
      maxCostUsdMicros: 360_000,
    });
  });

  it("preserves the legacy unauthenticated response", async () => {
    mocks.getApproval.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const response = await GET(new Request("https://opencompany.test"), {
      params: Promise.resolve({ runId: "gcr_1" }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
