import type { Actor } from "@opencompany/core";
import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import {
  createGoatPendingCheckoutRecord,
  markGoatCheckoutRecordOpen,
} from "@opencompany/db/goat-credits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoatBillingApplicationService } from "./application-service";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@opencompany/db/goat-billing", () => ({
  ensureGoatMonthlyIncludedUsage: vi.fn(),
  isGoatCreditsEnforcementEnabled: vi.fn(() => true),
  loadGoatBillingOverview: vi.fn(),
  setGoatAutoRefillConfig: vi.fn(),
  setGoatStripeCustomerId: vi.fn(),
}));
vi.mock("@opencompany/db/goat-credits", () => ({
  createGoatPendingCheckoutRecord: vi.fn().mockResolvedValue(undefined),
  getGoatCreditBalanceUsdMicros: vi.fn(),
  loadGoatCreditOverview: vi.fn(),
  loadGoatSpendBreakdown: vi.fn(),
  markGoatCheckoutRecordFailed: vi.fn().mockResolvedValue(undefined),
  markGoatCheckoutRecordOpen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./stripe", () => ({ assertGoatCheckoutEnabled: vi.fn() }));

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};

describe("Goat billing application service", () => {
  const checkoutCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      billing: { plan: "pro", stripeCustomerId: "cus_1" },
      memberCount: 2,
    } as never);
    checkoutCreate.mockResolvedValue({
      id: "cs_1",
      url: "https://checkout.stripe.test/session",
    });
  });

  it("replays a durable billing command without creating a second Stripe session", async () => {
    const db = commandDb();
    const service = createGoatBillingApplicationService({
      db,
      stripe: { checkout: { sessions: { create: checkoutCreate } } } as never,
      appUrl: "https://app.example.test",
    });

    await expect(
      service.createCreditTopUp(actor, { amountCents: 1_000, idempotencyKey: "topup-1" }),
    ).resolves.toEqual({ redirectUrl: "https://checkout.stripe.test/session" });
    await expect(
      service.createCreditTopUp(actor, { amountCents: 1_000, idempotencyKey: "topup-1" }),
    ).resolves.toEqual({ redirectUrl: "https://checkout.stripe.test/session" });

    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        payment_intent_data: { setup_future_usage: "off_session" },
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^goat-topup-/u) }),
    );
    expect(createGoatPendingCheckoutRecord).toHaveBeenCalledTimes(1);
    expect(markGoatCheckoutRecordOpen).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a billing key for a changed request", async () => {
    const db = commandDb();
    const service = createGoatBillingApplicationService({
      db,
      stripe: { checkout: { sessions: { create: checkoutCreate } } } as never,
      appUrl: "https://app.example.test",
    });
    await service.createCreditTopUp(actor, { amountCents: 1_000, idempotencyKey: "topup-2" });

    await expect(
      service.createCreditTopUp(actor, { amountCents: 2_000, idempotencyKey: "topup-2" }),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it("authorizes workspace billing commands before reserving or calling Stripe", async () => {
    const db = commandDb();
    const service = createGoatBillingApplicationService({
      db,
      stripe: { checkout: { sessions: { create: checkoutCreate } } } as never,
      appUrl: "https://app.example.test",
    });

    await expect(
      service.createCreditTopUp(
        { ...actor, role: "member" },
        { amountCents: 1_000, idempotencyKey: "member-topup" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });
});

function commandDb() {
  let command: Record<string, unknown> | null = null;
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (command) return [];
            command = {
              ...values,
              response: null,
              completedAt: null,
              createdAt: new Date("2026-08-13T12:00:00.000Z"),
            };
            return [command];
          },
        }),
      }),
    }),
    select: (selection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (selection && "email" in selection) return [{ email: "admin@example.test" }];
            if (selection && "name" in selection) return [{ name: "Acme" }];
            return command ? [command] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (!command || command.completedAt) return [];
            command = { ...command, ...values };
            return [{ commandId: command.commandId }];
          },
        }),
      }),
    }),
  };
}
