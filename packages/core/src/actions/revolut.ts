import {
  GoatRevolutApiError,
  type GoatRevolutBusinessConnection,
  loadGoatRevolutBusinessConnection,
  requestGoatRevolutBusinessApi,
} from "../integrations/revolut";
import {
  GOAT_ACTION_EFFECTS_READ,
  GoatActionAuthError,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  truncateText,
} from "./types";

const DEFAULT_EXPENSE_LIMIT = 50;
const MAX_EXPENSE_LIMIT = 100;
const DEFAULT_EXPENSE_LOOKBACK_DAYS = 30;
const MAX_EXPENSE_PERIOD_DAYS = 366;
const MAX_COMPACT_TEXT_CHARS = 200;
const MAX_LABELS = 20;

type RevolutAccount = {
  id?: string;
  name?: string;
  balance?: number;
  currency?: string;
  state?: string;
  public?: boolean;
  created_at?: string;
  updated_at?: string;
};

type RevolutAmount = {
  amount?: number;
  currency?: string;
};

type RevolutExpense = {
  id?: string;
  state?: string;
  transaction_type?: string;
  description?: string;
  merchant?: unknown;
  payer?: unknown;
  transaction_id?: string;
  expense_date?: string;
  labels?: Record<string, unknown>;
  receipt_ids?: unknown[];
  spent_amount?: RevolutAmount;
  splits?: unknown[];
};

export async function resolveRevolutActions(
  workspaceId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connection = loadGoatRevolutBusinessConnection(workspaceId);
  if (!connection) return null;

  return {
    id: "revolut",
    label: `Revolut Business (${connection.accountLabel}, ${connection.environment})`,
    description:
      "Read Revolut Business accounts and expenses from an env-configured Business API token. This experimental connector is read-only and does not upload receipts or initiate payments.",
    actions: [
      {
        id: "revolut.get_accounts",
        provider: "revolut",
        capability: "read",
        effects: GOAT_ACTION_EFFECTS_READ,
        permissionMode: "on",
        description:
          "List Revolut Business accounts visible to the configured read-only Business API token, including account id, label, currency, state, and balance. Does not return account numbers or card details.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        execute: async (params, context) => {
          validateAllowedParams(params, new Set());
          const accounts = await withRevolutAuth(connection, () =>
            requestGoatRevolutBusinessApi<RevolutAccount[]>({
              connection,
              path: "/accounts",
              signal: context.signal,
            }),
          );
          return {
            connection: connectionSummary(connection),
            accountCount: Array.isArray(accounts) ? accounts.length : 0,
            accounts: Array.isArray(accounts) ? compactAccounts(accounts) : [],
          };
        },
      },
      {
        id: "revolut.list_expenses",
        provider: "revolut",
        capability: "read",
        effects: GOAT_ACTION_EFFECTS_READ,
        permissionMode: "on",
        description:
          "List Revolut Business expenses for a bounded date range. Use state=missing_info to inspect expenses that still need information. Set onlyMissingReceipts=true to keep only expenses with no receipt ids. Defaults to the trailing 30 days and a limit of 50.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: {
              type: "string",
              description:
                "Optional inclusive start date as YYYY-MM-DD or an ISO 8601 instant. Defaults to 30 days before to.",
            },
            to: {
              type: "string",
              description:
                "Optional exclusive end date as YYYY-MM-DD or an ISO 8601 instant. Defaults to tomorrow in UTC so today's expenses are included.",
            },
            state: {
              type: "string",
              description:
                "Optional Revolut expense state filter, for example missing_info, draft, pending_review, rejected, or completed.",
            },
            transactionType: {
              type: "string",
              description:
                "Optional Revolut transaction type filter, for example card_payment, fee, transfer, external, or mileage_reimbursement.",
            },
            limit: {
              type: "number",
              minimum: 1,
              maximum: MAX_EXPENSE_LIMIT,
              description: `Maximum expenses to return (default ${DEFAULT_EXPENSE_LIMIT}, max ${MAX_EXPENSE_LIMIT}).`,
            },
            onlyMissingReceipts: {
              type: "boolean",
              description:
                "When true, keep only returned expenses whose receipt_ids array is empty or absent.",
            },
          },
        },
        execute: async (params, context) => {
          validateAllowedParams(
            params,
            new Set(["from", "to", "state", "transactionType", "limit", "onlyMissingReceipts"]),
          );
          const limit = expenseLimit(params);
          const period = resolveExpensePeriod(params, context.currentDate);
          const state = optionalSafeFilter(params, "state");
          const transactionType = optionalSafeFilter(params, "transactionType");
          const onlyMissingReceipts = optionalBooleanParam(params, "onlyMissingReceipts") ?? false;
          const expenses = await withRevolutAuth(connection, () =>
            requestGoatRevolutBusinessApi<RevolutExpense[]>({
              connection,
              path: "/expenses",
              params: {
                from: period.from,
                to: period.to,
                count: limit,
                state,
                transaction_type: transactionType,
              },
              signal: context.signal,
            }),
          );
          const rawExpenses = Array.isArray(expenses) ? expenses : [];
          const compact = rawExpenses.map(compactExpense).filter((expense) => {
            return !onlyMissingReceipts || expense.receiptCount === 0;
          });
          return {
            connection: connectionSummary(connection),
            period,
            filters: {
              state,
              transactionType,
              onlyMissingReceipts,
            },
            returnedByProvider: rawExpenses.length,
            expenseCount: compact.length,
            partial: rawExpenses.length >= limit,
            expenses: compact,
            note:
              rawExpenses.length >= limit
                ? "The provider returned the requested limit. Narrow the date range or paginate manually with a smaller to date based on the last expense_date for completeness."
                : "Read-only Revolut Business expenses. Missing receipt status is inferred from receipt_ids being empty or absent.",
          };
        },
      },
      {
        id: "revolut.get_expense",
        provider: "revolut",
        capability: "read",
        effects: GOAT_ACTION_EFFECTS_READ,
        permissionMode: "on",
        description:
          "Retrieve one Revolut Business expense by id, including safe summary fields, receipt ids, labels, and split count. Does not download receipt binary content.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["expenseId"],
          properties: {
            expenseId: {
              type: "string",
              minLength: 1,
              description: "The Revolut expense id returned by revolut.list_expenses.",
            },
          },
        },
        execute: async (params, context) => {
          validateAllowedParams(params, new Set(["expenseId"]));
          const expenseId = requiredUuidLikeParam(params, "expenseId");
          const expense = await withRevolutAuth(connection, () =>
            requestGoatRevolutBusinessApi<RevolutExpense>({
              connection,
              path: `/expenses/${encodeURIComponent(expenseId)}`,
              signal: context.signal,
            }),
          );
          return {
            connection: connectionSummary(connection),
            expense: compactExpense(expense),
          };
        },
      },
    ],
  };
}

async function withRevolutAuth<T>(
  connection: GoatRevolutBusinessConnection,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GoatRevolutApiError && (error.status === 401 || error.status === 403)) {
      throw new GoatActionAuthError(
        "auth_expired",
        "revolut",
        `Revolut Business rejected the configured API token for ${connection.accountLabel}. Generate a fresh READ-scoped access token and update REVOLUT_BUSINESS_API_TOKEN.`,
      );
    }
    throw error;
  }
}

function validateAllowedParams(params: Record<string, unknown>, allowed: ReadonlySet<string>) {
  const unexpected = Object.keys(params).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new GoatActionInvalidParamsError(`Unexpected parameter ${JSON.stringify(unexpected)}.`);
  }
}

function expenseLimit(params: Record<string, unknown>) {
  const value = optionalNumberParam(params, "limit");
  if (value === undefined) return DEFAULT_EXPENSE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPENSE_LIMIT) {
    throw new GoatActionInvalidParamsError(
      `"limit" must be an integer from 1 to ${MAX_EXPENSE_LIMIT}.`,
    );
  }
  return value;
}

function resolveExpensePeriod(params: Record<string, unknown>, currentDate: Date) {
  const to = optionalStringParam(params, "to")
    ? normalizeDateParam(optionalStringParam(params, "to")!, "to")
    : formatUtcDate(addUtcDays(currentDate, 1));
  const from =
    optionalStringParam(params, "from") ??
    formatUtcDate(addUtcDays(new Date(`${to}T00:00:00.000Z`), -DEFAULT_EXPENSE_LOOKBACK_DAYS));
  const normalizedFrom = normalizeDateParam(from, "from");

  const fromDate = new Date(`${normalizedFrom}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  const durationMs = toDate.getTime() - fromDate.getTime();
  if (durationMs <= 0) {
    throw new GoatActionInvalidParamsError('"from" must be earlier than the exclusive "to".');
  }
  if (durationMs > MAX_EXPENSE_PERIOD_DAYS * 24 * 60 * 60 * 1_000) {
    throw new GoatActionInvalidParamsError(
      `The expense period must be ${MAX_EXPENSE_PERIOD_DAYS} days or less.`,
    );
  }
  return { from: normalizedFrom, to };
}

function normalizeDateParam(value: string, key: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new GoatActionInvalidParamsError(
      `"${key}" must be YYYY-MM-DD or an ISO 8601 instant ending in Z or a numeric UTC offset.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new GoatActionInvalidParamsError(`"${key}" is not a valid date.`);
  }
  return formatUtcDate(parsed);
}

function optionalSafeFilter(params: Record<string, unknown>, key: string) {
  const value = optionalStringParam(params, key);
  if (value === undefined) return undefined;
  if (!/^[a-z][a-z0-9_]{0,80}$/.test(value)) {
    throw new GoatActionInvalidParamsError(
      `"${key}" must contain only lowercase letters, numbers, and underscores.`,
    );
  }
  return value;
}

function optionalBooleanParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new GoatActionInvalidParamsError(`"${key}" must be a boolean.`);
  }
  return value;
}

function requiredUuidLikeParam(params: Record<string, unknown>, key: string) {
  const value = optionalStringParam(params, key);
  if (!value) {
    throw new GoatActionInvalidParamsError(`"${key}" is required and must be a non-empty string.`);
  }
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(value)) {
    throw new GoatActionInvalidParamsError(`"${key}" is not a valid Revolut id.`);
  }
  return value;
}

function compactAccounts(accounts: readonly RevolutAccount[]) {
  return accounts.flatMap((account) => {
    const id = compactString(account.id, 120);
    const currency = normalizedCurrency(account.currency);
    if (!id || !currency) return [];
    return [
      {
        id,
        name: compactString(account.name, MAX_COMPACT_TEXT_CHARS),
        currency,
        balance: safeNumber(account.balance),
        state: compactString(account.state, 80),
        public: typeof account.public === "boolean" ? account.public : undefined,
        createdAt: compactIsoDate(account.created_at),
        updatedAt: compactIsoDate(account.updated_at),
      },
    ];
  });
}

function compactExpense(expense: RevolutExpense) {
  const receiptIds = compactReceiptIds(expense.receipt_ids);
  return {
    id: compactString(expense.id, 120),
    state: compactString(expense.state, 80),
    transactionType: compactString(expense.transaction_type, 80),
    description: compactString(expense.description, MAX_COMPACT_TEXT_CHARS),
    merchant: compactMerchant(expense.merchant),
    payer: compactUnknownLabel(expense.payer),
    transactionId: compactString(expense.transaction_id, 120),
    expenseDate: compactIsoDate(expense.expense_date) ?? compactString(expense.expense_date, 80),
    spentAmount: compactAmount(expense.spent_amount),
    receiptCount: receiptIds.length,
    receiptIds,
    labels: compactLabels(expense.labels),
    splitCount: Array.isArray(expense.splits) ? expense.splits.length : undefined,
    needsReceipt: receiptIds.length === 0,
  };
}

function compactAmount(value: RevolutAmount | undefined) {
  const amount = safeNumber(value?.amount);
  const currency = normalizedCurrency(value?.currency);
  if (amount === undefined || !currency) return undefined;
  return { amount, currency };
}

function compactMerchant(value: unknown) {
  if (!value) return undefined;
  if (typeof value === "string") return truncateText(value, MAX_COMPACT_TEXT_CHARS);
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = compactUnknownLabel(record.name ?? record.merchant_name ?? record.display_name);
  const category = compactUnknownLabel(record.category ?? record.mcc);
  const city = compactUnknownLabel(record.city);
  const country = compactUnknownLabel(record.country);
  if (!name && !category && !city && !country) return undefined;
  return { name, category, city, country };
}

function compactLabels(value: Record<string, unknown> | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .slice(0, MAX_LABELS)
    .flatMap(([key, raw]) => {
      const labelKey = compactString(key, 80);
      const labelValue = compactUnknownLabel(raw);
      return labelKey && labelValue ? [[labelKey, labelValue] as const] : [];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactReceiptIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = compactString(entry, 120);
    return id ? [id] : [];
  });
}

function connectionSummary(connection: GoatRevolutBusinessConnection) {
  return {
    label: connection.accountLabel,
    environment: connection.environment,
  };
}

function compactUnknownLabel(value: unknown) {
  if (typeof value === "string") return truncateText(value.replace(/\s+/g, " ").trim(), 160);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function compactString(value: unknown, maxChars: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return truncateText(normalized, maxChars);
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedCurrency(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z]{3}$/.test(value)) return undefined;
  return value.toUpperCase();
}

function compactIsoDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function addUtcDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatUtcDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
