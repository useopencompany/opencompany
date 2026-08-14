import { createHash } from "node:crypto";
import { captureServerEvent } from "@opencompany/analytics/server";
import type { Actor } from "@opencompany/core";
import {
  ensureGoatMonthlyIncludedUsage,
  isGoatCreditsEnforcementEnabled,
  loadGoatBillingOverview,
  setGoatAutoRefillConfig,
  setGoatStripeCustomerId,
} from "@opencompany/db/goat-billing";
import {
  GOAT_AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
  GOAT_DEFAULT_TOP_UP_USD_CENTS,
  GOAT_HOBBY_INCLUDED_USAGE_USD_CENTS,
  GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS,
  GOAT_LOW_BALANCE_WARN_USD_MICROS,
  GOAT_MAX_TOP_UP_USD_CENTS,
  GOAT_MIN_TOP_UP_USD_CENTS,
  GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
  GOAT_PRO_STRIPE_PRODUCT_KEY,
  GOAT_TOP_UP_AMOUNTS_USD_CENTS,
  goatWorkspaceMemberCap,
} from "@opencompany/db/goat-billing-constants";
import {
  createGoatPendingCheckoutRecord,
  getGoatCreditBalanceUsdMicros,
  loadGoatCreditOverview,
  loadGoatSpendBreakdown,
  markGoatCheckoutRecordFailed,
  markGoatCheckoutRecordOpen,
} from "@opencompany/db/goat-credits";
import {
  type GoatBillingCommandOperation,
  goatBillingCommandIdempotency,
  goatUsers,
  goatWorkspaces,
} from "@opencompany/db/goat-schema";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { assertGoatCheckoutEnabled } from "./stripe";

type DbLike = any;

export type GoatBillingOverviewData = {
  creditBalanceUsdMicros: number;
  includedBalanceUsdMicros: number;
  topUpBalanceUsdMicros: number;
  plan: "hobby" | "pro";
  subscriptionStatus: string | null;
  seatQuantity: number;
  includedUsagePeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  paymentNeedsAttention: boolean;
  proMonthlyPriceCents: number;
  hobbyIncludedUsageCents: number;
  memberCount: number;
  memberCap: number;
  spendThisMonthUsdMicros: number;
  spendThisMonthByCategory: {
    chat: number;
    ingestion: number;
    capabilities: number;
  };
  recentActivity: Array<{
    activityId: string;
    source: string;
    amountUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
    capabilityAction: string | null;
    isAutoRefill: boolean;
    createdAt: string;
  }>;
  lowBalanceWarnUsdMicros: number;
  includedUsagePerSeatCents: number;
  topUpAmountsCents: number[];
  defaultTopUpCents: number;
  minTopUpCents: number;
  maxTopUpCents: number;
  autoRefillMonthlyMaxCents: number;
  autoRefill: {
    enabled: boolean;
    amountCents: number;
    hasPaymentMethod: boolean;
    lastError: string | null;
  };
  isAdmin: boolean;
};

export type GoatUsageData = {
  breakdown: Array<{
    day: string;
    category: "chat" | "ingestion" | "capabilities" | "other";
    spendUsdMicros: number;
    providerCostUsdMicros: number;
    platformFeeUsdMicros: number;
  }>;
  ingestedThisMonth: number;
  pending: number;
  creditBalanceUsdMicros: number;
  providers: Array<{ provider: string; count: number }>;
  recent: Array<{
    activityId: string;
    provider: string;
    rawEventCount: number;
    status: "pending" | "consumed";
    createdAt: string;
  }>;
};

export type GoatBillingApplicationService = {
  getOverview(actor: Actor): Promise<GoatBillingOverviewData>;
  getUsage(actor: Actor): Promise<GoatUsageData>;
  getBalance(actor: Actor): Promise<{
    balanceUsdMicros: number;
    lowBalanceWarnUsdMicros: number;
    enforcementEnabled: boolean;
  }>;
  createCreditTopUp(
    actor: Actor,
    input: { amountCents: number; idempotencyKey: string },
  ): Promise<{ redirectUrl: string }>;
  createProCheckout(
    actor: Actor,
    input: { idempotencyKey: string },
  ): Promise<{ redirectUrl: string }>;
  createBillingPortal(
    actor: Actor,
    input: { idempotencyKey: string },
  ): Promise<{ redirectUrl: string }>;
  updateAutoRefill(
    actor: Actor,
    input: { enabled: boolean; amountCents: number; idempotencyKey: string },
  ): Promise<{ updated: true }>;
};

export class GoatBillingApplicationError extends Error {
  constructor(
    readonly code: "forbidden" | "invalid_argument" | "idempotency_conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GoatBillingApplicationError";
  }
}

export function createGoatBillingApplicationService(input: {
  db: DbLike;
  stripe: Stripe;
  appUrl: string;
}): GoatBillingApplicationService {
  const db = input.db;
  const stripe = input.stripe;
  const appUrl = normalizedAppUrl(input.appUrl);

  return {
    async getOverview(actor) {
      const [overview, credit] = await Promise.all([
        loadGoatBillingOverview(actor.workspaceId, { db }),
        loadGoatCreditOverview(actor.workspaceId, { db }),
      ]);
      return {
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
        includedBalanceUsdMicros: overview.includedBalanceUsdMicros,
        topUpBalanceUsdMicros: overview.topUpBalanceUsdMicros,
        plan: overview.billing.plan,
        subscriptionStatus: overview.billing.subscriptionStatus,
        seatQuantity: overview.billing.seatQuantity,
        includedUsagePeriodEnd: overview.billing.includedUsagePeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: overview.billing.cancelAtPeriodEnd,
        currentPeriodEnd: overview.billing.currentPeriodEnd?.toISOString() ?? null,
        paymentNeedsAttention: overview.billing.paymentNeedsAttention,
        proMonthlyPriceCents: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
        hobbyIncludedUsageCents: GOAT_HOBBY_INCLUDED_USAGE_USD_CENTS,
        memberCount: overview.memberCount,
        memberCap: goatWorkspaceMemberCap(overview.billing.plan),
        spendThisMonthUsdMicros: credit.spendThisMonthUsdMicros,
        spendThisMonthByCategory: credit.spendThisMonthByCategory,
        recentActivity: credit.recentEntries.map((entry) => ({
          activityId: opaqueActivityId(actor.workspaceId, "credit", entry.id),
          source: entry.source,
          amountUsdMicros: entry.amountUsdMicros,
          providerCostUsdMicros: entry.providerCostUsdMicros,
          platformFeeUsdMicros: entry.platformFeeUsdMicros,
          capabilityAction:
            typeof entry.metadata.capabilityAction === "string"
              ? entry.metadata.capabilityAction
              : null,
          isAutoRefill: entry.metadata.kind === "auto_refill",
          createdAt: entry.createdAt.toISOString(),
        })),
        lowBalanceWarnUsdMicros: GOAT_LOW_BALANCE_WARN_USD_MICROS,
        includedUsagePerSeatCents: GOAT_INCLUDED_USAGE_PER_SEAT_USD_CENTS,
        topUpAmountsCents: [...GOAT_TOP_UP_AMOUNTS_USD_CENTS],
        defaultTopUpCents: GOAT_DEFAULT_TOP_UP_USD_CENTS,
        minTopUpCents: GOAT_MIN_TOP_UP_USD_CENTS,
        maxTopUpCents: GOAT_MAX_TOP_UP_USD_CENTS,
        autoRefillMonthlyMaxCents: GOAT_AUTO_REFILL_MONTHLY_MAX_USD_CENTS,
        autoRefill: overview.autoRefill,
        isAdmin: actor.role === "admin",
      };
    },

    async getUsage(actor) {
      const [overview, breakdown] = await Promise.all([
        loadGoatBillingOverview(actor.workspaceId, { db }),
        loadGoatSpendBreakdown(actor.workspaceId, { days: 30, db }),
      ]);
      return {
        breakdown,
        ingestedThisMonth: overview.ingestedThisMonth,
        pending: overview.pending,
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
        providers: overview.providers,
        recent: overview.recent.map(
          (entry: {
            id: string;
            provider: string;
            rawEventCount: number;
            status: "pending" | "consumed";
            createdAt: Date;
          }) => ({
            activityId: opaqueActivityId(actor.workspaceId, "ingestion", entry.id),
            provider: entry.provider,
            rawEventCount: entry.rawEventCount,
            status: entry.status,
            createdAt: entry.createdAt.toISOString(),
          }),
        ),
      };
    },

    async getBalance(actor) {
      await ensureGoatMonthlyIncludedUsage(actor.workspaceId, { db });
      return {
        balanceUsdMicros: await getGoatCreditBalanceUsdMicros(actor.workspaceId, db),
        lowBalanceWarnUsdMicros: GOAT_LOW_BALANCE_WARN_USD_MICROS,
        enforcementEnabled: isGoatCreditsEnforcementEnabled(),
      };
    },

    async createCreditTopUp(actor, command) {
      requireAdmin(actor, "Only workspace admins can add credits.");
      validateAmount(
        command.amountCents,
        `Credit top-ups must be between $${GOAT_MIN_TOP_UP_USD_CENTS / 100} and $${GOAT_MAX_TOP_UP_USD_CENTS / 100}.`,
      );
      const reservation = await reserveCommand(db, actor, {
        operation: "credit_topup.create",
        idempotencyKey: command.idempotencyKey,
        request: { amountCents: command.amountCents },
      });
      const replay = redirectReplay(reservation.response);
      if (replay) return replay;

      const checkoutRecordId = deterministicId("goat_chk", actor, reservation.idempotencyKey);
      try {
        const [overview, billingActor] = await Promise.all([
          loadGoatBillingOverview(actor.workspaceId, { db }),
          loadBillingActor(db, actor),
        ]);
        if (overview.billing.plan !== "pro") {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "Upgrade this workspace to Pro before adding credits.",
          );
        }
        assertGoatCheckoutEnabled();
        const customerId = await ensureStripeCustomer({
          db,
          stripe,
          actor,
          billingActor,
          existingCustomerId: overview.billing.stripeCustomerId,
          idempotencyKey: reservation.idempotencyKey,
        });
        await createGoatPendingCheckoutRecord({
          id: checkoutRecordId,
          workspaceId: actor.workspaceId,
          userWorkosId: actor.userId,
          amountCents: command.amountCents,
          db,
        });
        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            customer: customerId,
            allow_promotion_codes: true,
            success_url: `${appUrl}/settings/workspace/billing?topup=success`,
            cancel_url: `${appUrl}/settings/workspace/billing?topup=cancelled`,
            automatic_tax: { enabled: true },
            billing_address_collection: "required",
            customer_update: { address: "auto", name: "auto" },
            payment_intent_data: { setup_future_usage: "off_session" },
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  unit_amount: command.amountCents,
                  tax_behavior: "exclusive",
                  product_data: {
                    name: "OpenCompany credits",
                    description: "Usage credits for chat and brain ingestion",
                  },
                },
                quantity: 1,
              },
            ],
            metadata: {
              billingProduct: "goat_topup",
              goatWorkspaceId: actor.workspaceId,
              userWorkosId: actor.userId,
              checkoutRecordId,
              amountCents: String(command.amountCents),
            },
          },
          { idempotencyKey: stripeCommandKey("topup", actor, reservation.idempotencyKey) },
        );
        if (!session.url) {
          throw new GoatBillingApplicationError(
            "unavailable",
            "Stripe did not return a Checkout URL.",
          );
        }
        await markGoatCheckoutRecordOpen({
          id: checkoutRecordId,
          stripeCheckoutSessionId: session.id,
          metadata: {
            goatWorkspaceId: actor.workspaceId,
            userWorkosId: actor.userId,
            checkoutRecordId,
            amountCents: String(command.amountCents),
          },
          db,
        });
        const response = { redirectUrl: session.url };
        const firstCompletion = await completeCommand(db, reservation.commandId, response);
        if (firstCompletion) {
          await captureServerEvent("goat_billing_topup_started", actor.userId, {
            user_id: actor.userId,
            workspace_id: actor.workspaceId,
            amount_cents: command.amountCents,
          }).catch(() => undefined);
        }
        return response;
      } catch (error) {
        await markGoatCheckoutRecordFailed({
          id: checkoutRecordId,
          error: error instanceof Error ? error.message : "Top-up checkout failed to start.",
          db,
        }).catch(() => undefined);
        throw billingFailure(error, "Could not start the credit top-up checkout.");
      }
    },

    async createProCheckout(actor, command) {
      requireAdmin(actor, "Only workspace admins can change the plan.");
      const reservation = await reserveCommand(db, actor, {
        operation: "subscription_checkout.create",
        idempotencyKey: command.idempotencyKey,
        request: {},
      });
      const replay = redirectReplay(reservation.response);
      if (replay) return replay;

      try {
        assertGoatCheckoutEnabled();
        const [overview, billingActor] = await Promise.all([
          loadGoatBillingOverview(actor.workspaceId, { db }),
          loadBillingActor(db, actor),
        ]);
        if (overview.billing.plan === "pro") {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "This workspace already has an active seat subscription.",
          );
        }
        if (
          overview.billing.stripeSubscriptionId &&
          overview.billing.subscriptionStatus !== "canceled" &&
          overview.billing.subscriptionStatus !== "incomplete_expired"
        ) {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "This workspace already has a Stripe subscription. Open billing management instead.",
          );
        }
        const customerId = await ensureStripeCustomer({
          db,
          stripe,
          actor,
          billingActor,
          existingCustomerId: overview.billing.stripeCustomerId,
          idempotencyKey: reservation.idempotencyKey,
        });
        const subscriptions = await stripe.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 10,
        });
        const existingPro = subscriptions.data.find(
          (subscription) =>
            subscription.metadata.billingProduct === GOAT_PRO_STRIPE_PRODUCT_KEY &&
            subscription.status !== "canceled" &&
            subscription.status !== "incomplete_expired",
        );
        if (existingPro) {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "This workspace already has a seat subscription. Open billing management instead.",
          );
        }
        const seatQuantity = Math.max(1, Math.floor(overview.memberCount ?? 1));
        const session = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: customerId,
            allow_promotion_codes: true,
            success_url: `${appUrl}/settings/workspace/billing?checkout=success`,
            cancel_url: `${appUrl}/settings/workspace/billing?checkout=cancelled`,
            automatic_tax: { enabled: true },
            billing_address_collection: "required",
            tax_id_collection: { enabled: true },
            customer_update: { address: "auto", name: "auto" },
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  unit_amount: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
                  tax_behavior: "exclusive",
                  recurring: { interval: "month" },
                  product_data: {
                    name: "OpenCompany seat",
                    description: "$20/month with $20/month of included at-cost usage",
                  },
                },
                quantity: seatQuantity,
              },
            ],
            metadata: {
              billingProduct: GOAT_PRO_STRIPE_PRODUCT_KEY,
              goatWorkspaceId: actor.workspaceId,
            },
            subscription_data: {
              metadata: {
                billingProduct: GOAT_PRO_STRIPE_PRODUCT_KEY,
                goatWorkspaceId: actor.workspaceId,
              },
            },
          },
          {
            // Pin retries to the command's original hour. This preserves the
            // pre-cutover one-checkout-per-workspace/hour guard while keeping
            // a retry stable even when it crosses an hour boundary.
            idempotencyKey: `goat-pro-${actor.workspaceId}-${Math.floor(reservation.createdAt.getTime() / 3_600_000)}`,
          },
        );
        if (!session.url) {
          throw new GoatBillingApplicationError(
            "unavailable",
            "Stripe did not return a Checkout URL.",
          );
        }
        const response = { redirectUrl: session.url };
        const firstCompletion = await completeCommand(db, reservation.commandId, response);
        if (firstCompletion) {
          await captureServerEvent("goat_billing_pro_checkout_started", actor.userId, {
            user_id: actor.userId,
            workspace_id: actor.workspaceId,
            monthly_price_usd_cents: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
          }).catch(() => undefined);
        }
        return response;
      } catch (error) {
        throw billingFailure(error, "Could not start seat checkout.");
      }
    },

    async createBillingPortal(actor, command) {
      requireAdmin(actor, "Only workspace admins can manage billing.");
      const reservation = await reserveCommand(db, actor, {
        operation: "billing_portal.create",
        idempotencyKey: command.idempotencyKey,
        request: {},
      });
      const replay = redirectReplay(reservation.response);
      if (replay) return replay;
      try {
        const { billing } = await loadGoatBillingOverview(actor.workspaceId, { db });
        if (!billing.stripeCustomerId) {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "This workspace does not have a Stripe billing account yet.",
          );
        }
        const session = await stripe.billingPortal.sessions.create(
          {
            customer: billing.stripeCustomerId,
            return_url: `${appUrl}/settings/workspace/billing`,
          },
          { idempotencyKey: stripeCommandKey("portal", actor, reservation.idempotencyKey) },
        );
        const response = { redirectUrl: session.url };
        await completeCommand(db, reservation.commandId, response);
        return response;
      } catch (error) {
        throw billingFailure(error, "Could not open Stripe billing management.");
      }
    },

    async updateAutoRefill(actor, command) {
      requireAdmin(actor, "Only workspace admins can manage auto-refill.");
      validateAmount(
        command.amountCents,
        `Auto-refill amounts must be between $${GOAT_MIN_TOP_UP_USD_CENTS / 100} and $${GOAT_MAX_TOP_UP_USD_CENTS / 100}.`,
      );
      const reservation = await reserveCommand(db, actor, {
        operation: "auto_refill.update",
        idempotencyKey: command.idempotencyKey,
        request: { enabled: command.enabled, amountCents: command.amountCents },
      });
      if (reservation.response?.updated === true) return { updated: true };
      try {
        const overview = await loadGoatBillingOverview(actor.workspaceId, { db });
        if (overview.billing.plan !== "pro") {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "Upgrade this workspace to Pro before enabling auto-refill.",
          );
        }
        const updated = await setGoatAutoRefillConfig(
          {
            workspaceId: actor.workspaceId,
            enabled: command.enabled,
            amountCents: command.amountCents,
          },
          { db },
        );
        if (!updated) {
          throw new GoatBillingApplicationError(
            "invalid_argument",
            "Add credits once first — auto-refill charges the card saved during a top-up.",
          );
        }
        const response = { updated: true as const };
        await completeCommand(db, reservation.commandId, response);
        return response;
      } catch (error) {
        throw billingFailure(error, "Could not update auto-refill.");
      }
    },
  };
}

function requireAdmin(actor: Actor, message: string) {
  if (actor.role !== "admin") throw new GoatBillingApplicationError("forbidden", message);
}

function validateAmount(amountCents: number, message: string) {
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < GOAT_MIN_TOP_UP_USD_CENTS ||
    amountCents > GOAT_MAX_TOP_UP_USD_CENTS
  ) {
    throw new GoatBillingApplicationError("invalid_argument", message);
  }
}

async function loadBillingActor(db: DbLike, actor: Actor) {
  const [[user], [workspace]] = await Promise.all([
    db
      .select({ email: goatUsers.email })
      .from(goatUsers)
      .where(eq(goatUsers.workosUserId, actor.userId))
      .limit(1),
    db
      .select({ name: goatWorkspaces.name })
      .from(goatWorkspaces)
      .where(eq(goatWorkspaces.id, actor.workspaceId))
      .limit(1),
  ]);
  if (!user?.email || !workspace?.name) {
    throw new GoatBillingApplicationError(
      "unavailable",
      "The workspace billing identity is unavailable.",
    );
  }
  return { email: user.email, workspaceName: workspace.name };
}

async function ensureStripeCustomer(input: {
  db: DbLike;
  stripe: Stripe;
  actor: Actor;
  billingActor: { email: string; workspaceName: string };
  existingCustomerId: string | null;
  idempotencyKey: string;
}) {
  if (input.existingCustomerId) return input.existingCustomerId;
  const customer = await input.stripe.customers.create(
    {
      email: input.billingActor.email,
      name: input.billingActor.workspaceName,
      metadata: { goatWorkspaceId: input.actor.workspaceId },
    },
    {
      idempotencyKey: stripeCommandKey("customer", input.actor, input.idempotencyKey),
    },
  );
  return (
    (await setGoatStripeCustomerId(
      { workspaceId: input.actor.workspaceId, stripeCustomerId: customer.id },
      { db: input.db },
    )) ?? customer.id
  );
}

async function reserveCommand(
  db: DbLike,
  actor: Actor,
  input: {
    operation: GoatBillingCommandOperation;
    idempotencyKey: string;
    request: Record<string, unknown>;
  },
) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new GoatBillingApplicationError(
      "invalid_argument",
      "A valid Idempotency-Key is required.",
    );
  }
  const requestHash = sha256(JSON.stringify({ operation: input.operation, ...input.request }));
  const commandId = deterministicId("gbcmd", actor, idempotencyKey);
  const [inserted] = await db
    .insert(goatBillingCommandIdempotency)
    .values({
      commandId,
      userWorkosId: actor.userId,
      workspaceId: actor.workspaceId,
      idempotencyKey,
      requestHash,
      operation: input.operation,
    })
    .onConflictDoNothing()
    .returning();
  const row =
    inserted ??
    (
      await db
        .select()
        .from(goatBillingCommandIdempotency)
        .where(
          and(
            eq(goatBillingCommandIdempotency.userWorkosId, actor.userId),
            eq(goatBillingCommandIdempotency.workspaceId, actor.workspaceId),
            eq(goatBillingCommandIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
    )[0];
  if (!row) {
    throw new GoatBillingApplicationError(
      "unavailable",
      "The billing command could not be reserved.",
    );
  }
  if (row.operation !== input.operation || row.requestHash !== requestHash) {
    throw new GoatBillingApplicationError(
      "idempotency_conflict",
      "The Idempotency-Key was already used for another billing command.",
    );
  }
  return {
    commandId: row.commandId,
    idempotencyKey,
    createdAt: row.createdAt,
    response:
      row.completedAt && row.response && typeof row.response === "object"
        ? (row.response as Record<string, unknown>)
        : null,
  };
}

async function completeCommand(db: DbLike, commandId: string, response: Record<string, unknown>) {
  const [completed] = await db
    .update(goatBillingCommandIdempotency)
    .set({ response, completedAt: new Date(), touchedAt: new Date() })
    .where(
      and(
        eq(goatBillingCommandIdempotency.commandId, commandId),
        isNull(goatBillingCommandIdempotency.completedAt),
      ),
    )
    .returning({ commandId: goatBillingCommandIdempotency.commandId });
  return Boolean(completed);
}

function redirectReplay(response: Record<string, unknown> | null) {
  return response && typeof response.redirectUrl === "string"
    ? { redirectUrl: response.redirectUrl }
    : null;
}

function billingFailure(error: unknown, fallback: string) {
  return error instanceof GoatBillingApplicationError
    ? error
    : new GoatBillingApplicationError("unavailable", fallback);
}

function normalizedAppUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The billing application URL must be an HTTP origin.");
  }
  return url.origin;
}

function deterministicId(prefix: string, actor: Actor, idempotencyKey: string) {
  return `${prefix}_${sha256(`${actor.userId}:${actor.workspaceId}:${idempotencyKey}`).slice(0, 32)}`;
}

function stripeCommandKey(prefix: string, actor: Actor, idempotencyKey: string) {
  return `goat-${prefix}-${sha256(`${actor.userId}:${actor.workspaceId}:${idempotencyKey}`)}`;
}

function opaqueActivityId(workspaceId: string, kind: string, id: string | number) {
  return `billing_activity_${sha256(`${workspaceId}:${kind}:${id}`).slice(0, 24)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
