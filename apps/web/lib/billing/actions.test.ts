import { captureServerEvent } from "@opencompany/analytics/server";
import { captureException } from "@opencompany/observability";
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import {
  createPendingCheckoutRecord,
  fulfillCheckoutSession,
  markCheckoutRecordFailed,
  markCheckoutRecordOpen,
  newStripeCheckoutRecordId,
} from "@/lib/billing/service";
import { getAppUrl, getStripe } from "@/lib/billing/stripe";
import { createCreditCheckoutSession, verifyCreditCheckoutSessionReturn } from "./actions";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
}));

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    void callback();
  },
}));

vi.mock("@/lib/auth", () => ({
  AUTHENTICATION_REQUIRED_MESSAGE: "Your session expired. Sign in again to continue.",
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getAppUrl: vi.fn(),
  getStripe: vi.fn(),
}));

vi.mock("@/lib/billing/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/service")>();
  return {
    ...actual,
    createPendingCheckoutRecord: vi.fn(),
    fulfillCheckoutSession: vi.fn(),
    markCheckoutRecordFailed: vi.fn(),
    markCheckoutRecordOpen: vi.fn(),
    newStripeCheckoutRecordId: vi.fn(),
  };
});

const currentWorkspaceMock = vi.mocked(currentWorkspace);
const getStripeMock = vi.mocked(getStripe);
const getAppUrlMock = vi.mocked(getAppUrl);
const createPendingCheckoutRecordMock = vi.mocked(createPendingCheckoutRecord);
const fulfillCheckoutSessionMock = vi.mocked(fulfillCheckoutSession);
const markCheckoutRecordFailedMock = vi.mocked(markCheckoutRecordFailed);
const markCheckoutRecordOpenMock = vi.mocked(markCheckoutRecordOpen);
const newStripeCheckoutRecordIdMock = vi.mocked(newStripeCheckoutRecordId);
const captureExceptionMock = vi.mocked(captureException);
const captureServerEventMock = vi.mocked(captureServerEvent);
const revalidatePathMock = vi.mocked(revalidatePath);

describe("createCreditCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redirectMock.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`);
    });
    newStripeCheckoutRecordIdMock.mockReturnValue("chk_123");
    getAppUrlMock.mockReturnValue("https://app.example.com");
    currentWorkspaceMock.mockResolvedValue({
      authUser: { email: "user@example.com" },
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("rejects out-of-range top-up amounts", async () => {
    const result = await createCreditCheckoutSession(499);

    expect(result).toEqual({
      ok: false,
      error: "Top-up amount must be between 500 and 100000 cents.",
    });
    expect(getStripeMock).not.toHaveBeenCalled();
    expect(createPendingCheckoutRecordMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("returns an auth error without starting checkout when the session is missing", async () => {
    currentWorkspaceMock.mockResolvedValue(null);

    const result = await createCreditCheckoutSession(2500);

    expect(result).toEqual({
      ok: false,
      error: "Your session expired. Sign in again to continue.",
    });
    expect(getStripeMock).not.toHaveBeenCalled();
    expect(createPendingCheckoutRecordMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("creates a Stripe Checkout Session with attribution metadata", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    await expect(createCreditCheckoutSession(2500)).rejects.toThrow(
      "redirect:https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(createPendingCheckoutRecordMock).toHaveBeenCalledWith({
      id: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 2500,
    });
    expect(create).toHaveBeenCalledWith({
      mode: "payment",
      customer_email: "user@example.com",
      success_url:
        "https://app.example.com/personal/settings?billing=success&stripe_checkout_session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://app.example.com/personal/settings?billing=cancelled",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
        amountCents: "2500",
        checkoutRecordId: "chk_123",
      },
      payment_intent_data: {
        metadata: {
          workspaceId: "wks_123",
          userId: "usr_123",
          amountCents: "2500",
          checkoutRecordId: "chk_123",
        },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 2500,
            product_data: { name: "$25 Open Company credits" },
          },
        },
      ],
    });
    expect(markCheckoutRecordOpenMock).toHaveBeenCalledWith({
      id: "chk_123",
      stripeCheckoutSessionId: "cs_test_123",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
        amountCents: "2500",
        checkoutRecordId: "chk_123",
        stripeCheckoutSessionId: "cs_test_123",
      },
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("credit_top_up_started", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      checkout_record_id: "chk_123",
      amount_cents: 2500,
    });
  });

  it("uses the caller-provided return path for the Stripe redirect URLs", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    await expect(createCreditCheckoutSession(2500, "/company/settings")).rejects.toThrow(
      "redirect:https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          "https://app.example.com/company/settings?billing=success&stripe_checkout_session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://app.example.com/company/settings?billing=cancelled",
      }),
    );
  });

  it("falls back to /personal/settings for unsafe return paths", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    await expect(createCreditCheckoutSession(2500, "//evil.example.com/phish")).rejects.toThrow(
      "redirect:https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          "https://app.example.com/personal/settings?billing=success&stripe_checkout_session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://app.example.com/personal/settings?billing=cancelled",
      }),
    );
  });

  it("creates a Stripe Checkout Session for a custom top-up amount", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    await expect(createCreditCheckoutSession(1234)).rejects.toThrow(
      "redirect:https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(createPendingCheckoutRecordMock).toHaveBeenCalledWith({
      id: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 1234,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ amountCents: "1234" }),
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              unit_amount: 1234,
              product_data: { name: "$12.34 Open Company credits" },
            }),
          }),
        ],
      }),
    );
  });

  it("marks the pending record failed when Stripe does not return a URL", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_test_123", url: null });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    const result = await createCreditCheckoutSession(1000);

    expect(result).toEqual({ ok: false, error: "Stripe did not return a Checkout URL." });
    expect(markCheckoutRecordFailedMock).toHaveBeenCalledWith({
      id: "chk_123",
      error: "Stripe did not return a Checkout URL.",
    });
    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("captures checkout failures with workspace context", async () => {
    const error = new Error("Stripe unavailable");
    const create = vi.fn().mockRejectedValue(error);
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    const result = await createCreditCheckoutSession(1000);

    expect(result).toEqual({ ok: false, error: "Stripe unavailable" });
    expect(markCheckoutRecordFailedMock).toHaveBeenCalledWith({
      id: "chk_123",
      error: "Stripe unavailable",
    });
    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.billing_checkout_failed",
      workspace_id: "wks_123",
      user_id: "usr_123",
      checkout_record_id: "chk_123",
      amount_cents: 1000,
      checkout_stage: "create_stripe_session",
    });
  });

  it("captures checkout configuration failures before creating a record", async () => {
    const error = new Error("STRIPE_SECRET_KEY is required for Stripe billing.");
    getStripeMock.mockImplementation(() => {
      throw error;
    });

    const result = await createCreditCheckoutSession(1000);

    expect(result).toEqual({
      ok: false,
      error: "STRIPE_SECRET_KEY is required for Stripe billing.",
    });
    expect(createPendingCheckoutRecordMock).not.toHaveBeenCalled();
    expect(markCheckoutRecordFailedMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        event: "opencompany.billing_checkout_failed",
        workspace_id: "wks_123",
        user_id: "usr_123",
        amount_cents: 1000,
        checkout_stage: "initialize",
      }),
    );
  });
});

describe("verifyCreditCheckoutSessionReturn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      authUser: { email: "user@example.com" },
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("retrieves and fulfills the returned Stripe Checkout Session", async () => {
    const session = {
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
        checkoutRecordId: "chk_123",
        amountCents: "2500",
      },
    };
    const retrieve = vi.fn().mockResolvedValue(session);
    getStripeMock.mockReturnValue({ checkout: { sessions: { retrieve } } } as never);
    fulfillCheckoutSessionMock.mockResolvedValue({
      ok: true,
      checkoutRecordId: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 2500,
      balanceCents: 5000,
      ledgerId: 22,
    });

    const result = await verifyCreditCheckoutSessionReturn("cs_test_123");

    expect(result).toEqual({ ok: true, status: "fulfilled" });
    expect(retrieve).toHaveBeenCalledWith("cs_test_123");
    expect(fulfillCheckoutSessionMock).toHaveBeenCalledWith(session);
    expect(captureServerEventMock).toHaveBeenCalledWith("credit_top_up_completed", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      checkout_record_id: "chk_123",
      ledger_id: 22,
      amount_cents: 2500,
      balance_cents: 5000,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/company/settings");
    expect(revalidatePathMock).toHaveBeenCalledWith("/personal/settings");
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("treats an already fulfilled returned Checkout Session as verified", async () => {
    const session = {
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
      },
    };
    const retrieve = vi.fn().mockResolvedValue(session);
    getStripeMock.mockReturnValue({ checkout: { sessions: { retrieve } } } as never);
    fulfillCheckoutSessionMock.mockResolvedValue({
      ok: false,
      reason: "already_fulfilled",
    });

    const result = await verifyCreditCheckoutSessionReturn("cs_test_123");

    expect(result).toEqual({ ok: true, status: "already_fulfilled" });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("captures returned Checkout Sessions for the wrong workspace or user", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {
        workspaceId: "wks_other",
        userId: "usr_other",
      },
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { retrieve } } } as never);

    const result = await verifyCreditCheckoutSessionReturn("cs_test_123");

    expect(result).toEqual({ ok: false, error: "Could not verify checkout." });
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Stripe Checkout Session return metadata mismatch." }),
      expect.objectContaining({
        event: "opencompany.billing_checkout_return_mismatch",
        workspace_id: "wks_123",
        user_id: "usr_123",
        stripe_checkout_session_id: "cs_test_123",
      }),
    );
  });

  it("captures returned Checkout Sessions that cannot be fulfilled", async () => {
    const session = {
      id: "cs_test_123",
      payment_status: "paid",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
      },
    };
    const retrieve = vi.fn().mockResolvedValue(session);
    getStripeMock.mockReturnValue({ checkout: { sessions: { retrieve } } } as never);
    fulfillCheckoutSessionMock.mockResolvedValue({
      ok: false,
      reason: "missing_metadata",
    });

    const result = await verifyCreditCheckoutSessionReturn("cs_test_123");

    expect(result).toEqual({ ok: false, error: "Could not verify checkout." });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Stripe checkout return fulfillment failed: missing_metadata",
      }),
      expect.objectContaining({
        event: "opencompany.billing_checkout_return_fulfillment_failed",
        fulfillment_reason: "missing_metadata",
      }),
    );
  });
});
