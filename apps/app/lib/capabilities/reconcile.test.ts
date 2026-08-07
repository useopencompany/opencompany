import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expireApprovals: vi.fn(),
  getRun: vi.fn(),
  getWalletBalance: vi.fn(),
  listUnsettledRuns: vi.fn(),
  settleRun: vi.fn(),
}));

vi.mock("@opencompany/db/capabilities", () => ({
  expirePendingCapabilityApprovals: mocks.expireApprovals,
  listUnsettledCapabilityRuns: mocks.listUnsettledRuns,
}));
vi.mock("@opencompany/telemetry", () => ({
  METRICS: { capabilityWalletBalanceUsdMicros: "goat.capability.wallet_balance" },
  recordHistogram: vi.fn(),
}));
vi.mock("@/lib/capabilities/execute", () => ({
  settleManagedCapabilityRun: mocks.settleRun,
}));
vi.mock("@/lib/capabilities/monid", () => ({
  isTerminalMonidRun: (status: string) =>
    ["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"].includes(status),
  MonidClient: class {
    getRun = mocks.getRun;
    getWalletBalance = mocks.getWalletBalance;
  },
}));

import { reconcileCapabilities } from "@/lib/capabilities/reconcile";

describe("reconcileCapabilities", () => {
  beforeEach(() => {
    vi.stubEnv("MONID_API_KEY", "monid_test");
    mocks.expireApprovals.mockResolvedValue(0);
    mocks.getWalletBalance.mockRejectedValue(new Error("wallet unavailable"));
    mocks.settleRun.mockResolvedValue({
      success: false,
      totalCostUsdMicros: 1_800,
      message: "failed",
    });
  });

  it("preserves a semantic provider-output failure while delayed cost settles", async () => {
    const auditRun = unsettledAuditRun({
      errorCode: "provider_output_invalid",
      errorMessage: "The capability returned data that could not be safely used.",
    });
    const providerRun = completedProviderRun();
    mocks.listUnsettledRuns.mockResolvedValue([auditRun]);
    mocks.getRun.mockResolvedValue(providerRun);

    await expect(reconcileCapabilities()).resolves.toMatchObject({
      candidates: 1,
      settled: 1,
      pending: 0,
      failed: 0,
    });
    expect(mocks.settleRun).toHaveBeenCalledWith({
      auditRun,
      providerRun,
      forceFailure: {
        code: "provider_output_invalid",
        message: "The capability returned data that could not be safely used.",
      },
    });
  });

  it("prioritizes a live endpoint mismatch over a stored failure marker", async () => {
    const auditRun = unsettledAuditRun({
      errorCode: "provider_output_invalid",
      errorMessage: "Stored failure.",
    });
    const providerRun = completedProviderRun({ endpoint: "/unreviewed" });
    mocks.listUnsettledRuns.mockResolvedValue([auditRun]);
    mocks.getRun.mockResolvedValue(providerRun);

    await reconcileCapabilities();

    expect(mocks.settleRun).toHaveBeenCalledWith({
      auditRun,
      providerRun,
      forceFailure: {
        code: "provider_contract_mismatch",
        message: "The paid capability returned a run for a different reviewed endpoint.",
      },
    });
  });
});

function unsettledAuditRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "gcr_1",
    workspaceId: "workspace_1",
    userWorkosId: "user_1",
    chatSessionId: "chat_1",
    source: "youtube",
    action: "youtube.find_in_transcript",
    provider: "apify",
    endpoint: "/starvibe/youtube-video-transcript",
    monidRunId: "monid_run_1",
    createdAt: new Date("2026-07-28T10:00:00.000Z"),
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function completedProviderRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "monid_run_1",
    provider: "apify",
    endpoint: "/starvibe/youtube-video-transcript",
    status: "COMPLETED",
    cost: { value: 0.0075, currency: "USD" },
    providerResponse: { httpStatus: 200 },
    ...overrides,
  };
}
