"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { centsToUsdMicros } from "@opencompany/billing";
import { captureException } from "@opencompany/observability";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";
import {
  isValidAutoRefillAmountCents,
  isValidAutoRefillThresholdCents,
  isValidTopUpAmountCents,
  isValidWeeklySpendLimitCents,
  MAX_AUTO_REFILL_AMOUNT_CENTS,
  MAX_TOP_UP_AMOUNT_CENTS,
  MAX_WEEKLY_SPEND_LIMIT_CENTS,
  MIN_AUTO_REFILL_AMOUNT_CENTS,
  MIN_TOP_UP_AMOUNT_CENTS,
  MIN_WEEKLY_SPEND_LIMIT_CENTS,
} from "@/lib/billing/constants";
import {
  createPendingCheckoutRecord,
  loadWorkspaceBillingSettings,
  markCheckoutRecordFailed,
  markCheckoutRecordOpen,
  newStripeCheckoutRecordId,
  redeemCreditCodeForWorkspace,
  upsertWorkspaceBillingSettings,
} from "@/lib/billing/service";
import { getAppUrl, getStripe } from "@/lib/billing/stripe";

function revalidateBillingSurfaces() {
  revalidatePath("/company/settings");
  revalidatePath("/personal/settings");
}

function formatTopUpName(amountCents: number) {
  return `$${amountCents / 100} Open Company credits`;
}

// Checkout can start from either settings surface (/company/settings or
// /personal/settings); callers pass where Stripe should send the user back to.
// Only same-origin absolute paths are accepted ("//" would be protocol-relative).
function safeReturnPath(returnPath: string | undefined) {
  if (returnPath && returnPath.startsWith("/") && !returnPath.startsWith("//")) {
    return returnPath;
  }
  return "/personal/settings";
}

export async function createCreditCheckoutSession(amountCents: number, returnPath?: string) {
  if (!isValidTopUpAmountCents(amountCents)) {
    return {
      ok: false as const,
      error: `Top-up amount must be between ${MIN_TOP_UP_AMOUNT_CENTS} and ${MAX_TOP_UP_AMOUNT_CENTS} cents.`,
    };
  }

  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { authUser, user, workspace } = context;
  let checkoutRecordId: string | undefined;
  let pendingRecordCreated = false;
  let checkoutStage = "initialize";
  let checkoutUrl = "";
  const metadataBase = {
    workspaceId: workspace.id,
    userId: user.id,
    amountCents: String(amountCents),
  };

  try {
    const stripe = getStripe();
    const appUrl = getAppUrl();
    checkoutRecordId = newStripeCheckoutRecordId();
    const metadata = {
      ...metadataBase,
      checkoutRecordId,
    };

    checkoutStage = "create_pending_record";
    await createPendingCheckoutRecord({
      id: checkoutRecordId,
      workspaceId: workspace.id,
      userId: user.id,
      amountCents,
    });
    pendingRecordCreated = true;

    checkoutStage = "create_stripe_session";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: authUser.email,
      success_url: `${appUrl}${safeReturnPath(returnPath)}?billing=success`,
      cancel_url: `${appUrl}${safeReturnPath(returnPath)}?billing=cancelled`,
      metadata,
      payment_intent_data: { metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: formatTopUpName(amountCents) },
          },
        },
      ],
    });

    if (!session.url) {
      await markCheckoutRecordFailed({
        id: checkoutRecordId,
        error: "Stripe did not return a Checkout URL.",
      });
      return { ok: false as const, error: "Stripe did not return a Checkout URL." };
    }

    checkoutStage = "mark_checkout_open";
    await markCheckoutRecordOpen({
      id: checkoutRecordId,
      stripeCheckoutSessionId: session.id,
      metadata: {
        ...metadata,
        stripeCheckoutSessionId: session.id,
      },
    });

    checkoutUrl = session.url;
    const capturedCheckoutRecordId = checkoutRecordId;
    after(() =>
      captureServerEvent("credit_top_up_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        checkout_record_id: capturedCheckoutRecordId,
        amount_cents: amountCents,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start checkout.";

    captureException(error, {
      event: "opencompany.billing_checkout_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      checkout_record_id: checkoutRecordId,
      amount_cents: amountCents,
      checkout_stage: checkoutStage,
    });

    if (checkoutRecordId && pendingRecordCreated) {
      try {
        await markCheckoutRecordFailed({ id: checkoutRecordId, error: message });
      } catch (markError) {
        captureException(markError, {
          event: "opencompany.billing_checkout_mark_failed",
          workspace_id: workspace.id,
          user_id: user.id,
          checkout_record_id: checkoutRecordId,
          amount_cents: amountCents,
        });
      }
    }

    return { ok: false as const, error: message };
  }

  redirect(checkoutUrl);
}

export async function redeemCreditCode(code: string) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { user, workspace } = context;
  const result = await redeemCreditCodeForWorkspace({
    code,
    workspaceId: workspace.id,
    userId: user.id,
  });

  if (result.ok) {
    revalidatePath("/company/settings");
    revalidatePath("/", "layout");
  }

  return result;
}

// ── Spending limit + automatic refill settings ──────────────────────────────

export async function updateSpendLimit(input: {
  enabled: boolean;
  weeklyLimitCents: number | null;
}) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }
  const { workspace } = context;

  let weeklySpendLimitUsdMicros: number | null = null;
  if (input.weeklyLimitCents != null) {
    if (!isValidWeeklySpendLimitCents(input.weeklyLimitCents)) {
      return {
        ok: false as const,
        error: `Weekly limit must be between $${MIN_WEEKLY_SPEND_LIMIT_CENTS / 100} and $${
          MAX_WEEKLY_SPEND_LIMIT_CENTS / 100
        }.`,
      };
    }
    weeklySpendLimitUsdMicros = centsToUsdMicros(input.weeklyLimitCents);
  } else if (input.enabled) {
    return { ok: false as const, error: "Set a weekly limit amount before enabling it." };
  }

  await upsertWorkspaceBillingSettings(workspace.id, {
    spendLimitEnabled: input.enabled,
    weeklySpendLimitUsdMicros,
  });

  after(() =>
    captureServerEvent("spend_limit_updated", context.user.id, {
      workspace_id: workspace.id,
      enabled: input.enabled,
      weekly_limit_cents: input.weeklyLimitCents,
    }),
  );

  revalidateBillingSurfaces();
  return { ok: true as const };
}

export async function updateAutoRefillSettings(input: {
  enabled: boolean;
  thresholdCents: number;
  amountCents: number;
}) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }
  const { workspace } = context;

  if (input.enabled) {
    const settings = await loadWorkspaceBillingSettings(workspace.id);
    if (!settings?.stripeDefaultPaymentMethodId) {
      return { ok: false as const, error: "Add a card before enabling automatic refill." };
    }
    if (!isValidAutoRefillAmountCents(input.amountCents)) {
      return {
        ok: false as const,
        error: `Refill amount must be between $${MIN_AUTO_REFILL_AMOUNT_CENTS / 100} and $${
          MAX_AUTO_REFILL_AMOUNT_CENTS / 100
        }.`,
      };
    }
    if (!isValidAutoRefillThresholdCents(input.thresholdCents)) {
      return { ok: false as const, error: "Choose a valid refill threshold." };
    }
  }

  await upsertWorkspaceBillingSettings(workspace.id, {
    autoRefillEnabled: input.enabled,
    autoRefillThresholdUsdMicros: centsToUsdMicros(input.thresholdCents),
    autoRefillAmountUsdMicros: centsToUsdMicros(input.amountCents),
    // Re-enabling clears a prior decline/SCA flag so charges resume.
    ...(input.enabled ? { autoRefillStatus: "ok" as const } : {}),
  });

  after(() =>
    captureServerEvent("auto_refill_enabled", context.user.id, {
      workspace_id: workspace.id,
      enabled: input.enabled,
      threshold_cents: input.thresholdCents,
      amount_cents: input.amountCents,
    }),
  );

  revalidateBillingSurfaces();
  return { ok: true as const };
}

export async function disableAutoRefill() {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }
  await upsertWorkspaceBillingSettings(context.workspace.id, { autoRefillEnabled: false });
  revalidateBillingSurfaces();
  return { ok: true as const };
}

// Starts a Stripe Checkout in "setup" mode to save a card for off-session
// auto-refill charges. Creates/reuses the workspace's Stripe customer, then
// redirects to Stripe. The saved card is persisted from the webhook on return.
export async function startAutoRefillSetup(returnPath?: string) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }
  const { authUser, user, workspace } = context;

  let redirectUrl = "";
  try {
    const stripe = getStripe();
    const appUrl = getAppUrl();

    const settings = await loadWorkspaceBillingSettings(workspace.id);
    let customerId = settings?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: authUser.email,
        metadata: { workspaceId: workspace.id },
      });
      customerId = customer.id;
      await upsertWorkspaceBillingSettings(workspace.id, { stripeCustomerId: customerId });
    }

    const metadata = { kind: "auto_refill_setup", workspaceId: workspace.id, userId: user.id };
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      success_url: `${appUrl}${safeReturnPath(returnPath)}?billing=card_saved`,
      cancel_url: `${appUrl}${safeReturnPath(returnPath)}?billing=cancelled`,
      metadata,
      setup_intent_data: { metadata },
    });

    if (!session.url) {
      return { ok: false as const, error: "Stripe did not return a setup URL." };
    }
    redirectUrl = session.url;
  } catch (error) {
    captureException(error, {
      event: "opencompany.auto_refill_setup_failed",
      workspace_id: workspace.id,
    });
    return { ok: false as const, error: "Could not start card setup. Please try again." };
  }

  redirect(redirectUrl);
}
