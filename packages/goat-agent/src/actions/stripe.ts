import {
  GoatStripeApiError,
  type GoatStripeConnection,
  GoatStripeOAuthAuthError,
  loadGoatStripeConnection,
  markGoatStripeConnectionNeedsReauth,
  refreshGoatStripeConnectionAccessToken,
  requestGoatStripeApi,
} from "../integrations/stripe";
import {
  GoatActionAuthError,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  optionalStringParam,
} from "./types";

const STRIPE_PAGE_SIZE = 100;
const MAX_REVENUE_PAGES = 20;
const MAX_RECEIVABLE_PAGES = 10;
const MAX_SUBSCRIPTION_PAGES_PER_STATUS = 3;
const MAX_REVENUE_PERIOD_MS = 366 * 24 * 60 * 60 * 1_000;
const DEFAULT_REVENUE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TOP_RECEIVABLES = 10;
const STRIPE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
] as const;
const PAYMENT_ACTIVITY_CATEGORIES = new Set([
  "charge",
  "refund",
  "partial_capture_reversal",
  "charge_failure",
  "refund_failure",
  "dispute",
  "dispute_reversal",
  "fee",
]);

type StripeList<T> = {
  data?: T[];
  has_more?: boolean;
};

type StripeBalanceTransaction = {
  id?: string;
  amount?: number;
  fee?: number;
  net?: number;
  currency?: string;
  reporting_category?: string;
  status?: string;
};

type StripeBalanceAmount = {
  amount?: number;
  currency?: string;
  source_types?: Record<string, number>;
};

type StripeSubscriptionItem = {
  quantity?: number | null;
  price?: {
    billing_scheme?: "per_unit" | "tiered";
    currency?: string;
    transform_quantity?: unknown;
    unit_amount?: number | null;
    recurring?: {
      interval?: "day" | "week" | "month" | "year";
      interval_count?: number;
      usage_type?: "licensed" | "metered";
    } | null;
  };
};

type StripeSubscription = {
  id?: string;
  status?: string;
  cancel_at_period_end?: boolean;
  items?: {
    data?: StripeSubscriptionItem[];
  };
};

type StripeInvoice = {
  id?: string;
  number?: string | null;
  currency?: string;
  amount_due?: number;
  amount_remaining?: number;
  attempted?: boolean;
  collection_method?: "charge_automatically" | "send_invoice";
  created?: number;
  due_date?: number | null;
  next_payment_attempt?: number | null;
  hosted_invoice_url?: string | null;
};

type StripeCategoryTotal = {
  transactionCount: number;
  amount: number;
  fees: number;
  net: number;
};

type StripeCurrencyActivity = {
  currency: string;
  transactionCount: number;
  capturedPaymentVolume: number;
  partialCaptureReversalVolume: number;
  refundVolume: number;
  disputeVolume: number;
  stripeFees: number;
  netPaymentActivity: number;
  categoryBreakdown: Record<string, StripeCategoryTotal>;
};

export async function resolveStripeActions(
  workspaceId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connection = await loadGoatStripeConnection(workspaceId);
  if (!connection) return null;

  const accountLabel = boundedLabel(connection.accountName);
  return {
    id: "stripe",
    label: `Stripe (${accountLabel}, ${connection.livemode ? "live" : "test"} mode)`,
    description:
      "Read live payment activity, balances, subscription health, and open receivables from the workspace Stripe account.",
    actions: [
      {
        id: "stripe.get_revenue_summary",
        provider: "stripe",
        capability: "read",
        permissionMode: "on",
        description:
          "Summarize Stripe balance activity for a period, grouped by currency and Stripe reporting category. Returns captured payment volume, partial-capture reversals, refunds, disputes, net Stripe fees, and net payment activity. This is operational payment reporting, not GAAP revenue. Defaults to the trailing 7 days; for calendar periods pass start and end as ISO 8601 instants, with end exclusive.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {
            start: {
              type: "string",
              description:
                "Optional inclusive ISO 8601 instant with Z or a numeric UTC offset. Defaults to 7 days before end.",
            },
            end: {
              type: "string",
              description:
                "Optional exclusive ISO 8601 instant with Z or a numeric UTC offset. Defaults to the current time.",
            },
          },
        },
        execute: async (params, context) => {
          validateAllowedParams(params, new Set(["start", "end"]));
          const period = resolveRevenuePeriod(params, context.currentDate);
          const listing = await withStripeAuth(connection, () =>
            listStripePages<StripeBalanceTransaction>({
              connection,
              path: "/balance_transactions",
              params: {
                "created[gte]": Math.floor(period.start.getTime() / 1_000),
                "created[lt]": Math.floor(period.end.getTime() / 1_000),
              },
              maxPages: MAX_REVENUE_PAGES,
              signal: context.signal,
            }),
          );
          return {
            account: accountLabel,
            livemode: connection.livemode,
            period: {
              startInclusive: period.start.toISOString(),
              endExclusive: period.end.toISOString(),
            },
            amountsAreMinorUnits: true,
            transactionCount: listing.items.length,
            partial: listing.partial,
            currencies: summarizeBalanceActivity(listing.items),
            note: listing.partial
              ? `More than ${MAX_REVENUE_PAGES * STRIPE_PAGE_SIZE} balance transactions matched. Narrow the period for a complete total.`
              : "Operational Stripe balance activity; accounting revenue can differ because of recognition rules, taxes, and activity outside Stripe.",
          };
        },
      },
      {
        id: "stripe.get_balance",
        provider: "stripe",
        capability: "read",
        permissionMode: "on",
        description:
          "Get the Stripe account's current available and pending balances by currency. Amounts are returned in each currency's minor unit.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        execute: async (params, context) => {
          validateAllowedParams(params, new Set());
          const balance = await withStripeAuth(connection, () =>
            requestGoatStripeApi<{
              available?: StripeBalanceAmount[];
              pending?: StripeBalanceAmount[];
              connect_reserved?: StripeBalanceAmount[];
              instant_available?: StripeBalanceAmount[];
            }>({
              accessToken: connection.accessToken,
              path: "/balance",
              signal: context.signal,
            }),
          );
          return {
            account: accountLabel,
            livemode: connection.livemode,
            amountsAreMinorUnits: true,
            available: compactBalanceAmounts(balance.available),
            pending: compactBalanceAmounts(balance.pending),
            connectReserved: compactBalanceAmounts(balance.connect_reserved),
            instantAvailable: compactBalanceAmounts(balance.instant_available),
          };
        },
      },
      {
        id: "stripe.get_subscription_summary",
        provider: "stripe",
        capability: "read",
        permissionMode: "on",
        description:
          "Summarize current Stripe subscriptions by status, cancellations scheduled at period end, and estimated monthly recurring value by currency. The MRR estimate includes fixed per-unit recurring prices and excludes metered, tiered, or otherwise unpriced items.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        execute: async (params, context) => {
          validateAllowedParams(params, new Set());
          const listings = await withStripeAuth(connection, () =>
            Promise.all(
              STRIPE_SUBSCRIPTION_STATUSES.map(async (status) => ({
                status,
                ...(await listStripePages<StripeSubscription>({
                  connection,
                  path: "/subscriptions",
                  params: { status },
                  maxPages: MAX_SUBSCRIPTION_PAGES_PER_STATUS,
                  signal: context.signal,
                })),
              })),
            ),
          );
          return summarizeSubscriptions(connection, accountLabel, listings);
        },
      },
      {
        id: "stripe.get_receivables_summary",
        provider: "stripe",
        capability: "read",
        permissionMode: "on",
        description:
          "Summarize open Stripe invoices and outstanding receivables by currency, including overdue or previously attempted invoices that need attention and links to the largest open invoices.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        execute: async (params, context) => {
          validateAllowedParams(params, new Set());
          const listing = await withStripeAuth(connection, () =>
            listStripePages<StripeInvoice>({
              connection,
              path: "/invoices",
              params: { status: "open" },
              maxPages: MAX_RECEIVABLE_PAGES,
              signal: context.signal,
            }),
          );
          return summarizeReceivables(
            connection,
            accountLabel,
            listing.items,
            listing.partial,
            context.currentDate,
          );
        },
      },
    ],
  };
}

async function withStripeAuth<T>(connection: GoatStripeConnection, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GoatStripeApiError && error.status === 401) {
      try {
        connection.accessToken = await refreshGoatStripeConnectionAccessToken(connection);
        return await run();
      } catch (refreshError) {
        if (refreshError instanceof GoatStripeOAuthAuthError) {
          await markGoatStripeConnectionNeedsReauth(connection).catch(() => undefined);
          throw new GoatActionAuthError(
            "auth_expired",
            "stripe",
            "Stripe authorization expired or was revoked. Reconnect Stripe in Settings → Integrations, then retry.",
          );
        }
        if (refreshError instanceof GoatStripeApiError) error = refreshError;
        else throw refreshError;
      }
    }
    if (error instanceof GoatStripeApiError && (error.status === 401 || error.status === 403)) {
      await markGoatStripeConnectionNeedsReauth(connection).catch(() => undefined);
      throw new GoatActionAuthError(
        "auth_expired",
        "stripe",
        "Stripe authorization expired, was revoked, or lost a required read permission. Reconnect Stripe in Settings → Integrations, then retry.",
      );
    }
    throw error;
  }
}

async function listStripePages<T extends { id?: string }>(input: {
  connection: GoatStripeConnection;
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  maxPages: number;
  signal: AbortSignal;
}): Promise<{ items: T[]; partial: boolean }> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  let hasMore = false;
  for (let page = 0; page < input.maxPages; page += 1) {
    const response = await requestGoatStripeApi<StripeList<T>>({
      accessToken: input.connection.accessToken,
      path: input.path,
      params: {
        ...input.params,
        limit: STRIPE_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
      signal: input.signal,
    });
    const pageItems = Array.isArray(response.data) ? response.data : [];
    items.push(...pageItems);
    hasMore = response.has_more === true;
    if (!hasMore) break;
    const next = pageItems.at(-1)?.id;
    if (!next) return { items, partial: true };
    startingAfter = next;
  }
  return { items, partial: hasMore };
}

function resolveRevenuePeriod(params: Record<string, unknown>, currentDate: Date) {
  const endValue = optionalStringParam(params, "end");
  const end = endValue ? parseIsoInstant(endValue, "end") : new Date(currentDate);
  const startValue = optionalStringParam(params, "start");
  const start = startValue
    ? parseIsoInstant(startValue, "start")
    : new Date(end.getTime() - DEFAULT_REVENUE_PERIOD_MS);
  const duration = end.getTime() - start.getTime();
  if (duration <= 0) {
    throw new GoatActionInvalidParamsError('"start" must be earlier than the exclusive "end".');
  }
  if (duration > MAX_REVENUE_PERIOD_MS) {
    throw new GoatActionInvalidParamsError("The revenue period must be 366 days or less.");
  }
  return { start, end };
}

function parseIsoInstant(value: string, key: string) {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new GoatActionInvalidParamsError(
      `"${key}" must be an ISO 8601 instant ending in Z or a numeric UTC offset.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new GoatActionInvalidParamsError(`"${key}" is not a valid ISO 8601 instant.`);
  }
  return parsed;
}

function summarizeBalanceActivity(
  transactions: readonly StripeBalanceTransaction[],
): StripeCurrencyActivity[] {
  const byCurrency = new Map<string, StripeCurrencyActivity>();
  for (const transaction of transactions) {
    const currency = normalizedCurrency(transaction.currency);
    const category = normalizedStripeCategory(transaction.reporting_category);
    const amount = safeInteger(transaction.amount);
    const fee = safeInteger(transaction.fee);
    const net = safeInteger(transaction.net);
    if (!currency || !category || amount === null || fee === null || net === null) continue;

    let total = byCurrency.get(currency);
    if (!total) {
      total = {
        currency,
        transactionCount: 0,
        capturedPaymentVolume: 0,
        partialCaptureReversalVolume: 0,
        refundVolume: 0,
        disputeVolume: 0,
        stripeFees: 0,
        netPaymentActivity: 0,
        categoryBreakdown: {},
      };
      byCurrency.set(currency, total);
    }
    total.transactionCount += 1;
    // Most payment fees are the positive `fee` attached to a charge balance
    // transaction. Standalone `fee` reporting rows carry their signed impact
    // in `amount`, so subtracting it counts assessed fees positively and fee
    // refunds negatively.
    total.stripeFees += category === "fee" ? -amount : fee;
    if (category === "charge") total.capturedPaymentVolume += Math.max(0, amount);
    if (category === "partial_capture_reversal") {
      total.capturedPaymentVolume += Math.min(0, amount);
      total.partialCaptureReversalVolume += Math.abs(Math.min(0, amount));
    }
    if (category === "refund") total.refundVolume += Math.abs(Math.min(0, amount));
    if (category === "dispute") total.disputeVolume += Math.abs(Math.min(0, amount));
    if (PAYMENT_ACTIVITY_CATEGORIES.has(category)) total.netPaymentActivity += net;

    const categoryTotal = total.categoryBreakdown[category] ?? {
      transactionCount: 0,
      amount: 0,
      fees: 0,
      net: 0,
    };
    categoryTotal.transactionCount += 1;
    categoryTotal.amount += amount;
    categoryTotal.fees += fee;
    categoryTotal.net += net;
    total.categoryBreakdown[category] = categoryTotal;
  }
  return [...byCurrency.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency),
  );
}

function summarizeSubscriptions(
  connection: GoatStripeConnection,
  accountLabel: string,
  listings: Array<{
    status: (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];
    items: StripeSubscription[];
    partial: boolean;
  }>,
) {
  const statusCounts: Record<string, number> = {};
  const partialStatuses: string[] = [];
  let cancelAtPeriodEnd = 0;
  let excludedRecurringItems = 0;
  const estimatedMrrByCurrency = new Map<
    string,
    { currency: string; active: number; trialing: number; atRisk: number }
  >();

  for (const listing of listings) {
    statusCounts[listing.status] = listing.items.length;
    if (listing.partial) partialStatuses.push(listing.status);
    for (const subscription of listing.items) {
      if (subscription.cancel_at_period_end) cancelAtPeriodEnd += 1;
      for (const item of subscription.items?.data ?? []) {
        const monthly = estimatedMonthlyItemAmount(item);
        if (!monthly) {
          excludedRecurringItems += 1;
          continue;
        }
        const current = estimatedMrrByCurrency.get(monthly.currency) ?? {
          currency: monthly.currency,
          active: 0,
          trialing: 0,
          atRisk: 0,
        };
        if (listing.status === "active") current.active += monthly.amount;
        else if (listing.status === "trialing") current.trialing += monthly.amount;
        else if (listing.status === "past_due" || listing.status === "unpaid") {
          current.atRisk += monthly.amount;
        }
        estimatedMrrByCurrency.set(monthly.currency, current);
      }
    }
  }

  return {
    account: accountLabel,
    livemode: connection.livemode,
    amountsAreMinorUnits: true,
    statusCounts,
    cancelAtPeriodEnd,
    estimatedMonthlyRecurringValue: [...estimatedMrrByCurrency.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency),
    ),
    excludedRecurringItems,
    partial: partialStatuses.length > 0,
    partialStatuses,
    note: "MRR is an estimate from fixed recurring price amounts. Metered, tiered, transformed-quantity, and unpriced items are excluded; trialing and at-risk values are shown separately.",
  };
}

function estimatedMonthlyItemAmount(item: StripeSubscriptionItem) {
  const price = item.price;
  const recurring = price?.recurring;
  const currency = normalizedCurrency(price?.currency);
  const unitAmount = safeInteger(price?.unit_amount);
  const quantity = safePositiveInteger(item.quantity ?? 1);
  const intervalCount = safePositiveInteger(recurring?.interval_count ?? 1);
  if (
    !price ||
    !recurring ||
    price.billing_scheme === "tiered" ||
    price.transform_quantity != null ||
    recurring.usage_type === "metered" ||
    !currency ||
    unitAmount === null ||
    quantity === null ||
    intervalCount === null ||
    !isStripeRecurringInterval(recurring.interval)
  ) {
    return null;
  }

  const amountPerInterval = unitAmount * quantity;
  const monthlyMultiplier =
    recurring.interval === "day"
      ? 365.25 / 12 / intervalCount
      : recurring.interval === "week"
        ? 52 / 12 / intervalCount
        : recurring.interval === "month"
          ? 1 / intervalCount
          : 1 / 12 / intervalCount;
  return { currency, amount: Math.round(amountPerInterval * monthlyMultiplier) };
}

function isStripeRecurringInterval(
  value: unknown,
): value is NonNullable<NonNullable<StripeSubscriptionItem["price"]>["recurring"]>["interval"] {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

function summarizeReceivables(
  connection: GoatStripeConnection,
  accountLabel: string,
  invoices: readonly StripeInvoice[],
  partial: boolean,
  currentDate: Date,
) {
  const nowSeconds = Math.floor(currentDate.getTime() / 1_000);
  const byCurrency = new Map<
    string,
    {
      currency: string;
      openInvoiceCount: number;
      amountDue: number;
      amountRemaining: number;
      overdueInvoiceCount: number;
      overdueAmountRemaining: number;
      attemptedUnpaidInvoiceCount: number;
    }
  >();
  const compact = invoices.flatMap((invoice) => {
    const currency = normalizedCurrency(invoice.currency);
    const amountDue = safeInteger(invoice.amount_due);
    const amountRemaining = safeInteger(invoice.amount_remaining);
    if (!currency || amountDue === null || amountRemaining === null) return [];
    const overdue =
      typeof invoice.due_date === "number" &&
      Number.isSafeInteger(invoice.due_date) &&
      invoice.due_date < nowSeconds &&
      amountRemaining > 0;
    const attemptedUnpaid = invoice.attempted === true && amountRemaining > 0;
    const total = byCurrency.get(currency) ?? {
      currency,
      openInvoiceCount: 0,
      amountDue: 0,
      amountRemaining: 0,
      overdueInvoiceCount: 0,
      overdueAmountRemaining: 0,
      attemptedUnpaidInvoiceCount: 0,
    };
    total.openInvoiceCount += 1;
    total.amountDue += amountDue;
    total.amountRemaining += amountRemaining;
    if (overdue) {
      total.overdueInvoiceCount += 1;
      total.overdueAmountRemaining += amountRemaining;
    }
    if (attemptedUnpaid) total.attemptedUnpaidInvoiceCount += 1;
    byCurrency.set(currency, total);
    const invoiceUrl = safeStripeInvoiceUrl(invoice.hosted_invoice_url);

    return [
      {
        id: invoice.id,
        number: boundedLabel(invoice.number ?? invoice.id ?? "Invoice"),
        currency,
        amountRemaining,
        overdue,
        attemptedUnpaid,
        collectionMethod: invoice.collection_method,
        createdAt: unixSecondsToIso(invoice.created),
        dueAt: unixSecondsToIso(invoice.due_date),
        nextPaymentAttemptAt: unixSecondsToIso(invoice.next_payment_attempt),
        ...(invoiceUrl ? { url: invoiceUrl } : {}),
      },
    ];
  });

  return {
    account: accountLabel,
    livemode: connection.livemode,
    amountsAreMinorUnits: true,
    partial,
    currencies: [...byCurrency.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency),
    ),
    largestOpenInvoices: compact
      .toSorted((left, right) => right.amountRemaining - left.amountRemaining)
      .slice(0, MAX_TOP_RECEIVABLES),
    note: partial
      ? `More than ${MAX_RECEIVABLE_PAGES * STRIPE_PAGE_SIZE} open invoices matched, so the totals are partial.`
      : "Overdue means a send-invoice due date has passed. Attempted unpaid also flags automatic-collection invoices with a remaining balance after an attempt.",
  };
}

function compactBalanceAmounts(values: StripeBalanceAmount[] | undefined) {
  return (values ?? []).flatMap((entry) => {
    const currency = normalizedCurrency(entry.currency);
    const amount = safeInteger(entry.amount);
    if (!currency || amount === null) return [];
    return [
      {
        currency,
        amount,
        ...(entry.source_types && typeof entry.source_types === "object"
          ? { sourceTypes: compactSourceTypes(entry.source_types) }
          : {}),
      },
    ];
  });
}

function compactSourceTypes(value: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, amount]) => {
      const normalized = normalizedStripeCategory(key);
      return normalized && Number.isSafeInteger(amount) ? [[normalized, amount]] : [];
    }),
  );
}

function validateAllowedParams(params: Record<string, unknown>, allowed: ReadonlySet<string>) {
  const unexpected = Object.keys(params).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new GoatActionInvalidParamsError(`Unexpected parameter ${JSON.stringify(unexpected)}.`);
  }
}

function normalizedCurrency(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z]{3}$/.test(value)) return null;
  return value.toLowerCase();
}

function normalizedStripeCategory(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,80}$/.test(value)) return null;
  return value;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function safeStripeInvoiceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "invoice.stripe.com") return undefined;
    const normalized = url.toString();
    return normalized.length <= 1_000 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function boundedLabel(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim() || "Stripe account";
  return normalized.length > 100 ? `${normalized.slice(0, 99)}…` : normalized;
}
