import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getApproval: vi.fn() }));

vi.mock("@/lib/server-api-client", () => ({
  serverApiClient: vi.fn(async () => ({
    v1: {
      "capability-approvals": {
        "by-tool-call": { ":toolCallId": { $get: mocks.getApproval } },
      },
    },
  })),
}));

import { GET } from "./route";

describe("capability approval by tool call URL adapter", () => {
  beforeEach(() => {
    mocks.getApproval.mockResolvedValue(
      Response.json({
        data: {
          runId: "gcr_1",
          source: "lead",
          action: "lead.enrich_person",
          status: "awaiting_approval",
          maxCostUsdMicros: 360_000,
          expiresAt: "2026-07-23T10:15:00.000Z",
          settledCostUsdMicros: null,
          sessionBudgetUsdMicros: 250_000,
        },
      }),
    );
  });

  it("forwards the tool-call id and preserves the browser-polled body", async () => {
    const response = await GET(new Request("https://opencompany.test"), {
      params: Promise.resolve({ toolCallId: "tool_1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.getApproval).toHaveBeenCalledWith({ param: { toolCallId: "tool_1" } });
    await expect(response.json()).resolves.toMatchObject({
      runId: "gcr_1",
      status: "awaiting_approval",
      sessionBudgetUsdMicros: 250_000,
    });
  });
});
