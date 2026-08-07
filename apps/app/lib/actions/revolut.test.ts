import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockGoatRevolutApiError extends Error {
    readonly status: number;
    constructor(status: number) {
      super(`Revolut failed (${status}).`);
      this.status = status;
    }
  }
  return {
    GoatRevolutApiError: MockGoatRevolutApiError,
    loadGoatRevolutBusinessConnection: vi.fn(),
    requestGoatRevolutBusinessApi: vi.fn(),
  };
});

vi.mock("@opencompany/core/integrations/revolut", () => ({
  GoatRevolutApiError: mocks.GoatRevolutApiError,
  loadGoatRevolutBusinessConnection: mocks.loadGoatRevolutBusinessConnection,
  requestGoatRevolutBusinessApi: mocks.requestGoatRevolutBusinessApi,
}));

import { resolveRevolutActions } from "@/lib/actions/revolut";
import { GoatActionAuthError, GoatActionInvalidParamsError } from "@/lib/actions/types";

const connection = {
  workspaceId: "workspace_1",
  accountLabel: "Acme Revolut",
  apiToken: "oa_prod_testtokenwithenoughlength",
  apiBaseUrl: "https://b2b.revolut.com/api/1.0",
  environment: "production" as const,
};

beforeEach(() => {
  mocks.loadGoatRevolutBusinessConnection.mockReset();
  mocks.loadGoatRevolutBusinessConnection.mockReturnValue(connection);
  mocks.requestGoatRevolutBusinessApi.mockReset();
});

describe("resolveRevolutActions", () => {
  it("is absent when no env-gated Revolut connection is configured for the workspace", async () => {
    mocks.loadGoatRevolutBusinessConnection.mockReturnValue(null);
    await expect(resolveRevolutActions("workspace_1")).resolves.toBeNull();
  });

  it("lists compact accounts without account numbers or tokens", async () => {
    mocks.requestGoatRevolutBusinessApi.mockResolvedValue([
      {
        id: "account_1",
        name: "Current GBP account",
        balance: 123.45,
        currency: "gbp",
        state: "active",
        public: false,
        created_at: "2026-07-01T10:00:00.000Z",
        updated_at: "2026-07-02T10:00:00.000Z",
        iban: "SHOULD_NOT_APPEAR",
      },
    ]);

    const result = await executeAction("revolut.get_accounts", {});
    expect(result).toEqual({
      connection: {
        label: "Acme Revolut",
        environment: "production",
      },
      accountCount: 1,
      accounts: [
        {
          id: "account_1",
          name: "Current GBP account",
          currency: "GBP",
          balance: 123.45,
          state: "active",
          public: false,
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-02T10:00:00.000Z",
        },
      ],
    });
  });

  it("lists expenses with missing receipt filtering and bounded date params", async () => {
    mocks.requestGoatRevolutBusinessApi.mockResolvedValue([
      {
        id: "expense_1",
        state: "missing_info",
        transaction_type: "card_payment",
        description: "AWS",
        merchant: { name: "Amazon Web Services", city: "Dublin", country: "IE" },
        payer: "Ada",
        transaction_id: "transaction_1",
        expense_date: "2026-07-15T12:00:00.000Z",
        receipt_ids: [],
        spent_amount: { amount: 42.5, currency: "eur" },
        labels: { project: "infra", empty: "" },
        splits: [{ id: "split_1" }],
      },
      {
        id: "expense_2",
        state: "missing_info",
        receipt_ids: ["receipt_1"],
        spent_amount: { amount: 10, currency: "eur" },
      },
    ]);

    const result = await executeAction("revolut.list_expenses", {
      from: "2026-07-01",
      to: "2026-08-01",
      state: "missing_info",
      transactionType: "card_payment",
      limit: 25,
      onlyMissingReceipts: true,
    });

    expect(mocks.requestGoatRevolutBusinessApi).toHaveBeenCalledWith(
      expect.objectContaining({
        connection,
        path: "/expenses",
        params: {
          from: "2026-07-01",
          to: "2026-08-01",
          count: 25,
          state: "missing_info",
          transaction_type: "card_payment",
        },
      }),
    );
    expect(result).toMatchObject({
      expenseCount: 1,
      returnedByProvider: 2,
      filters: {
        state: "missing_info",
        transactionType: "card_payment",
        onlyMissingReceipts: true,
      },
      expenses: [
        {
          id: "expense_1",
          state: "missing_info",
          transactionType: "card_payment",
          merchant: { name: "Amazon Web Services", city: "Dublin", country: "IE" },
          spentAmount: { amount: 42.5, currency: "EUR" },
          receiptCount: 0,
          receiptIds: [],
          labels: { project: "infra" },
          splitCount: 1,
          needsReceipt: true,
        },
      ],
    });
  });

  it("retrieves one compact expense", async () => {
    mocks.requestGoatRevolutBusinessApi.mockResolvedValue({
      id: "expense_123",
      state: "completed",
      receipt_ids: ["receipt_1"],
      spent_amount: { amount: 10, currency: "usd" },
    });

    await expect(
      executeAction("revolut.get_expense", { expenseId: "expense_123" }),
    ).resolves.toMatchObject({
      expense: {
        id: "expense_123",
        state: "completed",
        spentAmount: { amount: 10, currency: "USD" },
        receiptCount: 1,
        needsReceipt: false,
      },
    });
    expect(mocks.requestGoatRevolutBusinessApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/expenses/expense_123" }),
    );
  });

  it("rejects unsafe provider filters before calling Revolut", async () => {
    await expect(
      executeAction("revolut.list_expenses", { state: "missing-info" }),
    ).rejects.toBeInstanceOf(GoatActionInvalidParamsError);
    expect(mocks.requestGoatRevolutBusinessApi).not.toHaveBeenCalled();
  });

  it("maps 401 and 403 provider responses to an auth error", async () => {
    mocks.requestGoatRevolutBusinessApi.mockRejectedValue(new mocks.GoatRevolutApiError(401));

    await expect(executeAction("revolut.get_accounts", {})).rejects.toBeInstanceOf(
      GoatActionAuthError,
    );
  });
});

async function executeAction(actionId: string, params: Record<string, unknown>) {
  const catalog = await resolveRevolutActions("workspace_1");
  const action = catalog?.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`Missing action ${actionId}.`);
  return await action.execute(params, {
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    signal: new AbortController().signal,
    currentDate: new Date("2026-08-04T12:00:00Z"),
    userTimezone: "UTC",
  });
}
