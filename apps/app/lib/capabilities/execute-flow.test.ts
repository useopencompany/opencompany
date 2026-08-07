import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeApproval: vi.fn(),
  createRun: vi.fn(),
  getBudget: vi.fn(),
  sumSpend: vi.fn(),
  isWorkspaceCapabilityEnabled: vi.fn(),
  markStarted: vi.fn(),
  markSettlementFailure: vi.fn(),
  markStopping: vi.fn(),
  settleRun: vi.fn(),
  getBalance: vi.fn(),
  recordDebit: vi.fn(),
  autoRefill: vi.fn(),
}));

vi.mock("@opencompany/db/capabilities", () => ({
  consumeGoatCapabilityApprovalByToolCall: mocks.consumeApproval,
  createGoatCapabilityRun: mocks.createRun,
  getGoatCapabilitySessionBudgetUsdMicros: mocks.getBudget,
  isGoatWorkspaceCapabilityEnabled: mocks.isWorkspaceCapabilityEnabled,
  markGoatCapabilityRunStarted: mocks.markStarted,
  markGoatCapabilityRunSettlementFailure: mocks.markSettlementFailure,
  markGoatCapabilityRunStopping: mocks.markStopping,
  settleGoatCapabilityRun: mocks.settleRun,
  sumGoatCapabilitySessionSpendUsdMicros: mocks.sumSpend,
}));
vi.mock("@opencompany/db/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opencompany/db/billing")>()),
  ensureGoatMonthlyIncludedUsage: vi.fn().mockResolvedValue({ ok: false, reason: "current" }),
}));
vi.mock("@opencompany/db/credits", () => ({
  getGoatCreditBalanceUsdMicros: mocks.getBalance,
  recordGoatCreditDebit: mocks.recordDebit,
}));
vi.mock("@/lib/billing/auto-refill", () => ({
  maybeTriggerGoatAutoRefill: mocks.autoRefill,
}));

import type { GoatActionExecuteContext } from "@/lib/actions/types";
import { GoatActionInvalidParamsError } from "@/lib/actions/types";
import type { ManagedCapabilityActionSpec } from "@/lib/capabilities/catalog";
import {
  evaluateManagedCapabilityApproval,
  executeManagedCapability,
  GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
} from "@/lib/capabilities/execute";
import {
  MonidApiError,
  type MonidClient,
  type MonidInspection,
  type MonidRun,
} from "@/lib/capabilities/monid";

describe("executeManagedCapability", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("MANAGED_CAPABILITIES_KILL_SWITCH", "");
    mocks.getBalance.mockResolvedValue(10_000_000);
    mocks.getBudget.mockResolvedValue(5_000_000);
    mocks.sumSpend.mockResolvedValue(0);
    mocks.isWorkspaceCapabilityEnabled.mockResolvedValue(true);
    mocks.createRun.mockImplementation(async (input) => auditRow(input));
    mocks.consumeApproval.mockResolvedValue(null);
    mocks.markStarted.mockResolvedValue({});
    mocks.markSettlementFailure.mockResolvedValue(undefined);
    mocks.markStopping.mockResolvedValue(undefined);
    mocks.settleRun.mockResolvedValue({});
    mocks.recordDebit.mockResolvedValue({
      ok: true,
      ledgerId: 1,
      balanceUsdMicros: 9_998_200,
    });
  });

  it("automatically runs a cheap action and settles provider cost at cost", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ cost: { value: 0.0015, currency: "USD" } }),
    });
    const result = await executeManagedCapability({
      spec: spec(),
      params: { query: "openai" },
      context: context(),
      client,
    });
    expect(client.inspect).toHaveBeenCalledBefore(client.run);
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(mocks.recordDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "capability_usage",
        idempotencyKey: "capability:monid_run_1",
        providerCostUsdMicros: 1_500,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 1_500,
      }),
    );
    expect(mocks.settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        providerCostUsdMicros: 1_500,
        totalCostUsdMicros: 1_500,
      }),
    );
    expect(result).toMatchObject({
      untrustedProviderData: true,
      resultCount: 1,
      cost: { totalUsdMicros: 1_500, state: "settled" },
    });
  });

  it("shapes provider output before applying separate payload array and string limits", async () => {
    const transcript = "x".repeat(5_000);
    const mapOutput = vi.fn(() => ({
      matches: [{ text: "first" }, { text: "second" }, { text: "third" }],
      transcript,
    }));
    const action = {
      ...spec(),
      mapInput: (params: Record<string, unknown>) => ({
        providerInput: { keyword: params.query },
        resultLimit: 1,
        payloadArrayLimit: 3,
        payloadStringLimit: transcript.length,
        discoverPayloadLinks: false,
        canonicalLinks: ["https://x.com/openai/status/1"],
      }),
      mapOutput,
    };
    const providerOutput = {
      transcript: [{ text: "unbounded provider data" }],
    };
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({
        output: providerOutput,
        cost: { value: 0.0015, currency: "USD" },
      }),
    });

    const result = await executeManagedCapability({
      spec: action,
      params: { query: "openai" },
      context: context(),
      client,
    });

    expect(mapOutput).toHaveBeenCalledWith(providerOutput, { query: "openai" });
    expect(result.payload).toEqual({
      matches: [{ text: "first" }, { text: "second" }, { text: "third" }],
      transcript,
    });
    expect(result.resultCount).toBe(1);
    expect(result.canonicalLinks).toEqual(["https://x.com/openai/status/1"]);
  });

  it("charges completed provider work but marks unusable mapped output as failed", async () => {
    const action = {
      ...spec(),
      mapOutput: () => {
        throw new Error("untrusted parser detail");
      },
    };
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ cost: { value: 0.0015, currency: "USD" } }),
    });

    await expect(
      executeManagedCapability({
        spec: action,
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "provider_error" });

    expect(mocks.recordDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCostUsdMicros: 1_500,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 1_500,
      }),
    );
    expect(mocks.settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "provider_output_invalid",
        errorMessage: "The capability returned data that could not be safely used.",
      }),
    );
  });

  it("keeps an unusable mapped output failed while its provider cost is still settling", async () => {
    const action = {
      ...spec(),
      mapOutput: () => {
        throw new Error("untrusted parser detail");
      },
    };
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ cost: null }),
    });

    await expect(
      executeManagedCapability({
        spec: action,
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "provider_error" });

    expect(mocks.markSettlementFailure).toHaveBeenCalledWith({
      id: "gcr_1",
      errorCode: "provider_output_invalid",
      errorMessage: "The capability returned data that could not be safely used.",
    });
    expect(mocks.settleRun).not.toHaveBeenCalled();
  });

  it("settles completed work when output validation reports invalid params", async () => {
    const action = {
      ...spec(),
      mapOutput: () => {
        throw new GoatActionInvalidParamsError("Use the canonical LinkedIn company URL.");
      },
    };
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ cost: { value: 0.0015, currency: "USD" } }),
    });

    await expect(
      executeManagedCapability({
        spec: action,
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ name: "GoatActionInvalidParamsError" });

    expect(mocks.recordDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCostUsdMicros: 1_500,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 1_500,
      }),
    );
    expect(mocks.settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        providerCostUsdMicros: 1_500,
        totalCostUsdMicros: 1_500,
      }),
    );
  });

  it("sends reviewed query parameters in the Monid input envelope", async () => {
    const action = {
      ...spec("seo.get_domain_overview", "seo", "semrush", "/domain_rank"),
      inputLocation: "queryParams" as const,
      mapInput: () => ({
        providerInput: { domain: "opencompany.cloud", database: "us" },
        resultLimit: 1,
        canonicalLinks: ["https://opencompany.cloud/"],
      }),
    };
    const client = fakeClient({
      inspection: {
        ...inspectPrice(0.002),
        provider: "semrush",
        endpoint: "/domain_rank",
        input: {
          queryParams: {
            type: "object",
            properties: {
              domain: { type: "string" },
              database: { type: "string" },
            },
            required: ["domain"],
          },
        },
      },
      run: providerRun({
        provider: "semrush",
        endpoint: "/domain_rank",
        cost: { value: 0.002, currency: "USD" },
      }),
    });

    await executeManagedCapability({
      spec: action,
      params: { domain: "opencompany.cloud", country: "US" },
      context: context(),
      client,
    });

    expect(client.run).toHaveBeenCalledWith(
      {
        provider: "semrush",
        endpoint: "/domain_rank",
        input: {
          queryParams: {
            domain: "opencompany.cloud",
            database: "us",
          },
        },
      },
      expect.any(AbortSignal),
    );
  });

  it("keeps a completed run unsettled until Monid reports its final cost", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ cost: null }),
    });
    const result = await executeManagedCapability({
      spec: spec(),
      params: { query: "openai" },
      context: context(),
      client,
    });
    expect(mocks.recordDebit).not.toHaveBeenCalled();
    expect(mocks.settleRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cost: { totalUsdMicros: null, state: "settling" },
    });
  });

  it("retains a run id from a malformed paid response for later reconciliation", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun(),
    });
    client.run.mockRejectedValueOnce(
      new MonidApiError("Malformed capability run response.", 502, {
        runId: "monid_run_drifted",
        async: true,
      }),
    );
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(mocks.markStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        monidRunId: "monid_run_drifted",
        async: true,
      }),
    );
    expect(mocks.settleRun).not.toHaveBeenCalled();
    expect(mocks.recordDebit).not.toHaveBeenCalled();
  });

  it("settles explicit zero-cost provider failures without a credit debit", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({
        cost: { value: 0, currency: "USD" },
        output: null,
        providerResponse: { httpStatus: 404 },
      }),
    });
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(mocks.recordDebit).not.toHaveBeenCalled();
    expect(mocks.settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        providerCostUsdMicros: 0,
        totalCostUsdMicros: 0,
      }),
    );
  });

  it("durably records and rejects a provider run for a different endpoint", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({
        endpoint: "/unreviewed",
        cost: { value: 0.0015, currency: "USD" },
      }),
    });
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(mocks.markStarted).toHaveBeenCalledWith(
      expect.objectContaining({ monidRunId: "monid_run_1" }),
    );
    expect(mocks.settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "provider_contract_mismatch",
      }),
    );
  });

  it("fails closed before inspection when the global kill switch is enabled", async () => {
    vi.stubEnv("MANAGED_CAPABILITIES_KILL_SWITCH", "true");
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun(),
    });
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(client.inspect).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
  });

  it("fails closed before inspection when the exact reviewed action is disabled", async () => {
    vi.stubEnv("DISABLED_MANAGED_CAPABILITY_ACTIONS", "linkedin.list_comments, x.search_posts");
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun(),
    });
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(client.inspect).not.toHaveBeenCalled();
  });

  it("rejects a stale catalog after an admin disables the workspace source", async () => {
    mocks.isWorkspaceCapabilityEnabled.mockResolvedValue(false);
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun(),
    });
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(client.inspect).not.toHaveBeenCalled();
  });

  it("creates a 15-minute exact approval when a quote would exceed the session budget", async () => {
    mocks.getBudget.mockResolvedValue(100_000);
    const client = fakeClient({
      inspection: inspectPrice(0.3),
      run: providerRun(),
    });
    const now = new Date("2026-07-23T10:00:00.000Z");
    const approvalContext = context();
    await expect(
      evaluateManagedCapabilityApproval({
        spec: spec("lead.find_person_email", "lead", "pdl", "/v5/person/enrich"),
        params: { query: "ada@example.com" },
        toolCallId: "tool_1",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        turnState: approvalContext.capabilityTurnState!,
        client,
        now: () => now,
      }),
    ).resolves.toBe(true);
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        quoteProviderCostUsdMicros: 300_000,
        quotePlatformFeeUsdMicros: 0,
        quoteTotalCostUsdMicros: 300_000,
        approvalExpiresAt: new Date("2026-07-23T10:15:00.000Z"),
      }),
    );
    expect(client.run).not.toHaveBeenCalled();
  });

  it("falls through without a card when quote inspection fails", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun(),
    });
    client.inspect.mockRejectedValueOnce(new Error("inspect unavailable"));
    const approvalContext = context();

    await expect(
      evaluateManagedCapabilityApproval({
        spec: spec(),
        params: { query: "openai" },
        toolCallId: "tool_1",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        turnState: approvalContext.capabilityTurnState!,
        client,
      }),
    ).resolves.toBe(false);
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("accounts for multiple admitted calls before their run rows exist", async () => {
    mocks.getBudget.mockResolvedValue(2_500);
    const approvalContext = context();
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun(),
    });

    await expect(
      evaluateManagedCapabilityApproval({
        spec: spec(),
        params: { query: "first" },
        toolCallId: "tool_1",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        turnState: approvalContext.capabilityTurnState!,
        client,
      }),
    ).resolves.toBe(false);
    await expect(
      evaluateManagedCapabilityApproval({
        spec: spec(),
        params: { query: "second" },
        toolCallId: "tool_2",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        turnState: approvalContext.capabilityTurnState!,
        client,
      }),
    ).resolves.toBe(true);

    expect(approvalContext.capabilityTurnState).toMatchObject({
      quotedTotalUsdMicros: 1_500,
      admittedToolCallIds: ["tool_1"],
    });
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tool_2",
        status: "awaiting_approval",
      }),
    );
  });

  it("reuses the gate quote during execution without inspecting twice", async () => {
    const client = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ cost: { value: 0.0015, currency: "USD" } }),
    });
    const approvalContext = context();
    await expect(
      evaluateManagedCapabilityApproval({
        spec: spec(),
        params: { query: "openai" },
        toolCallId: "tool_1",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        turnState: approvalContext.capabilityTurnState!,
        client,
      }),
    ).resolves.toBe(false);
    await executeManagedCapability({
      spec: spec(),
      params: { query: "openai" },
      context: approvalContext,
      client,
    });
    expect(client.inspect).toHaveBeenCalledTimes(1);
    expect(client.run).toHaveBeenCalledTimes(1);
  });

  it("consumes only an approval that still covers the exact tool call, action, and parameter hash", async () => {
    mocks.consumeApproval.mockResolvedValue(auditRow({ status: "executing" }));
    const client = fakeClient({
      inspection: inspectPrice(0.3),
      run: providerRun({ cost: { value: 0.3, currency: "USD" } }),
    });
    const approvalContext = context();
    await executeManagedCapability({
      spec: spec("lead.find_person_email", "lead", "pdl", "/v5/person/enrich"),
      params: { query: "ada@example.com" },
      context: approvalContext,
      client,
    });
    expect(mocks.consumeApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tool_1",
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        chatSessionId: "chat_1",
        action: "lead.find_person_email",
        quoteTotalCostUsdMicros: 300_000,
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );

    mocks.consumeApproval.mockResolvedValueOnce(null);
    mocks.getBudget.mockResolvedValueOnce(100_000);
    const changedApprovalContext = context();
    await expect(
      executeManagedCapability({
        spec: spec("lead.find_person_email", "lead", "pdl", "/v5/person/enrich"),
        params: { query: "changed@example.com" },
        context: changedApprovalContext,
        client,
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });

  it("rejects insufficient workspace credits before creating or running", async () => {
    mocks.getBalance.mockResolvedValue(1_000);
    const client = fakeClient({
      inspection: inspectPrice(0.2),
      run: providerRun(),
    });
    await expect(
      executeManagedCapability({
        spec: spec(),
        params: { query: "openai" },
        context: context(),
        client,
      }),
    ).rejects.toMatchObject({
      code: "insufficient_credits",
    });
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
  });

  it("permits six asynchronous runs per turn and rejects a seventh without quoting it", async () => {
    const sharedContext = context();
    const clients = Array.from({ length: GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN + 1 }, (_, index) =>
      fakeClient({
        inspection: inspectPrice(0.01),
        run: providerRun({
          runId: `monid_run_${index + 1}`,
          status: "RUNNING",
          cost: null,
        }),
        polled: providerRun({
          runId: `monid_run_${index + 1}`,
          status: "COMPLETED",
          cost: { value: 0.01, currency: "USD" },
        }),
      }),
    );

    const results = await Promise.allSettled(
      clients.map((client, index) =>
        executeManagedCapability({
          spec: { ...spec(), executionMode: "async" },
          params: { query: `query ${index + 1}` },
          context: { ...sharedContext, toolCallId: `tool_${index + 1}` },
          client,
          pollIntervalMs: 1,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
    );
    const [rejected] = results.filter((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      code: "call_budget",
      message: `Only ${GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN} long-running paid capabilities can be started in a turn.`,
    });
    expect(clients.reduce((calls, client) => calls + client.run.mock.calls.length, 0)).toBe(
      GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
    );
    expect(clients.reduce((calls, client) => calls + client.getRun.mock.calls.length, 0)).toBe(
      GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
    );
    expect(sharedContext.capabilityTurnState).toMatchObject({
      quotedTotalUsdMicros: GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN * 10_000,
      asyncRunsStarted: GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
      admittedToolCallIds: Array.from(
        { length: GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN },
        (_, index) => `tool_${index + 1}`,
      ),
    });
    expect(sharedContext.capabilityTurnState?.quotesByToolCallId.size).toBe(
      GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
    );
  });

  it("releases a pre-admitted quote when the asynchronous run limit is reached", async () => {
    const sharedContext = context();
    sharedContext.capabilityTurnState!.asyncRunsStarted = GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN;
    const client = fakeClient({
      inspection: inspectPrice(0.01),
      run: providerRun(),
    });
    const action = { ...spec(), executionMode: "async" as const };

    await expect(
      evaluateManagedCapabilityApproval({
        spec: action,
        params: { query: "one more" },
        toolCallId: "tool_1",
        workspaceId: "workspace_1",
        userWorkosId: "user_1",
        chatSessionId: "chat_1",
        turnState: sharedContext.capabilityTurnState!,
        client,
      }),
    ).resolves.toBe(false);
    await expect(
      executeManagedCapability({
        spec: action,
        params: { query: "one more" },
        context: sharedContext,
        client,
      }),
    ).rejects.toMatchObject({ code: "call_budget" });

    expect(client.inspect).toHaveBeenCalledTimes(1);
    expect(client.run).not.toHaveBeenCalled();
    expect(sharedContext.capabilityTurnState).toMatchObject({
      quotedTotalUsdMicros: 0,
      admittedToolCallIds: [],
      asyncRunsStarted: GOAT_CAPABILITY_ASYNC_RUNS_PER_TURN,
    });
    expect(sharedContext.capabilityTurnState?.quotesByToolCallId.size).toBe(0);
  });

  it("allows sequential catalog-sync actions when Monid returns async job envelopes", async () => {
    const sharedContext = context();
    const firstClient = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ runId: "monid_run_1", status: "RUNNING", cost: null }),
      polled: providerRun({
        runId: "monid_run_1",
        status: "COMPLETED",
        cost: { value: 0.0015, currency: "USD" },
      }),
    });
    const secondClient = fakeClient({
      inspection: inspectPrice(0.0015),
      run: providerRun({ runId: "monid_run_2", status: "RUNNING", cost: null }),
      polled: providerRun({
        runId: "monid_run_2",
        status: "COMPLETED",
        cost: { value: 0.0015, currency: "USD" },
      }),
    });

    await executeManagedCapability({
      spec: spec(),
      params: { query: "first" },
      context: sharedContext,
      client: firstClient,
      pollIntervalMs: 1,
    });
    sharedContext.toolCallId = "tool_2";
    await executeManagedCapability({
      spec: spec(),
      params: { query: "second" },
      context: sharedContext,
      client: secondClient,
      pollIntervalMs: 1,
    });

    expect(firstClient.run).toHaveBeenCalledTimes(1);
    expect(secondClient.run).toHaveBeenCalledTimes(1);
    expect(firstClient.getRun).toHaveBeenCalledTimes(1);
    expect(secondClient.getRun).toHaveBeenCalledTimes(1);
    expect(firstClient.stopRun).not.toHaveBeenCalled();
    expect(secondClient.stopRun).not.toHaveBeenCalled();
    expect(sharedContext.capabilityTurnState).toMatchObject({
      quotedTotalUsdMicros: 3_000,
      asyncRunsStarted: 0,
      admittedToolCallIds: ["tool_1", "tool_2"],
    });
  });
});

function context(): GoatActionExecuteContext {
  return {
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    chatSessionId: "chat_1",
    toolCallId: "tool_1",
    capabilityTurnState: {
      quotedTotalUsdMicros: 0,
      admittedToolCallIds: [],
      quotesByToolCallId: new Map(),
      asyncRunsStarted: 0,
    },
    signal: new AbortController().signal,
    currentDate: new Date("2026-07-23T10:00:00.000Z"),
    userTimezone: "UTC",
  };
}

function spec(
  id = "x.search_posts",
  source: ManagedCapabilityActionSpec["source"] = "x",
  provider: ManagedCapabilityActionSpec["provider"] = "tikhub",
  endpoint = "/api/v1/twitter/web/fetch_search_timeline",
): ManagedCapabilityActionSpec {
  return {
    id,
    source,
    description: "Test action",
    params: { type: "object" },
    provider,
    endpoint,
    priceType: "PER_CALL",
    executionMode: "sync",
    mapInput: (params) => ({
      providerInput: { keyword: params.query },
      resultLimit: 1,
      canonicalLinks: [],
    }),
  };
}

function inspectPrice(amount: number): MonidInspection {
  return {
    id: "inspect_1",
    provider: amount === 0.3 ? "pdl" : "tikhub",
    endpoint: amount === 0.3 ? "/v5/person/enrich" : "/api/v1/twitter/web/fetch_search_timeline",
    input: { keyword: { type: "string" } },
    price: { type: "PER_CALL", amount, currency: "USD" },
    tags: ["verified"],
  };
}

function providerRun(overrides: Partial<MonidRun> = {}): MonidRun {
  const pdl = overrides.cost?.value === 0.3;
  return {
    runId: "monid_run_1",
    provider: pdl ? "pdl" : "tikhub",
    endpoint: pdl ? "/v5/person/enrich" : "/api/v1/twitter/web/fetch_search_timeline",
    status: "COMPLETED",
    output: [{ url: "https://x.com/openai/status/1" }],
    providerResponse: { httpStatus: 200 },
    resultCount: 1,
    ...overrides,
  };
}

function fakeClient(input: { inspection: MonidInspection; run: MonidRun; polled?: MonidRun }) {
  return {
    inspect: vi.fn(async () => input.inspection),
    run: vi.fn(async () => ({
      async: input.run.status === "RUNNING",
      httpStatus: input.run.status === "RUNNING" ? 202 : 200,
      run: input.run,
    })),
    getRun: vi.fn(async () => input.polled ?? input.run),
    stopRun: vi.fn(async () => ({ ...input.run, status: "STOPPED" as const })),
    getWalletBalance: vi.fn(),
  } as unknown as MonidClient & {
    inspect: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    stopRun: ReturnType<typeof vi.fn>;
  };
}

function auditRow(input: Record<string, unknown>) {
  return {
    id: "gcr_1",
    workspaceId: "workspace_1",
    userWorkosId: "user_1",
    chatSessionId: "chat_1",
    source: "x",
    action: "x.search_posts",
    approvalExpiresAt:
      input.approvalExpiresAt instanceof Date
        ? input.approvalExpiresAt
        : new Date("2026-07-23T10:15:00.000Z"),
    ...input,
  };
}
