import { getDb } from "@opencompany/db/client";
import { goatBrainIngestJobs, goatChatSessions, goatTasks } from "@opencompany/db/goat-schema";
import { goatGatewayReportingUser } from "@opencompany/goat-observability";
import { and, eq, inArray } from "drizzle-orm";

const VERCEL_AI_GATEWAY_REPORT_URL = "https://ai-gateway.vercel.sh/v1/report";
const USD_MICROS_PER_DOLLAR = 1_000_000;

export type GoatDailyUsageRow = {
  day: string;
  totalCostUsdMicros: number;
  chatCostUsdMicros: number;
  taskCostUsdMicros: number;
  brainCostUsdMicros: number;
  marketCostUsdMicros: number;
  surchargeCostUsdMicros: number;
  gatewayCostUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  requestCount: number;
};

export type GoatUsageDrilldownItem = {
  tag: string;
  kind: "chat" | "task" | "ingest";
  id: string;
  label: string;
  href: string | null;
  totalCostUsdMicros: number;
  requestCount: number;
};

type GatewayReportRow = Record<string, unknown>;
type GoatUsageUserInput =
  | { userWorkosId: string; userWorkosIds?: never }
  | { userWorkosIds: readonly string[]; userWorkosId?: never };
type GatewayReportUser = {
  userWorkosId: string;
  reportingUserId: string;
};
type TaggedUsageRow = {
  tag: string;
  userWorkosId: string;
  totalCostUsdMicros: number;
  requestCount: number;
  kind: "chat" | "task" | "ingest";
  id: string;
};

const DAILY_USAGE_CATEGORY_FEATURES = [
  { category: "chatCostUsdMicros", features: ["chat", "chat-title"] },
  { category: "taskCostUsdMicros", features: ["task"] },
  { category: "brainCostUsdMicros", features: ["brain-ingest", "brain-query"] },
] as const;

export async function getGoatDailyUsage(input: GoatUsageUserInput & {
  apiKey: string;
  start: string;
  end: string;
}) {
  const reportUsers = gatewayReportUsers(input);
  if (reportUsers.length === 0) throw new Error("Could not build Goat Gateway reporting user.");

  const [reports, categoryRowsByUser] = await Promise.all([
    Promise.all(
      reportUsers.map((reportUser) =>
        fetchGatewayReport({
          apiKey: input.apiKey,
          start: input.start,
          end: input.end,
          groupBy: "day",
          userId: reportUser.reportingUserId,
          tags: ["app:goat"],
        }),
      ),
    ),
    Promise.all(
      reportUsers.map((reportUser) =>
        fetchDailyUsageCategoryRows({
          apiKey: input.apiKey,
          start: input.start,
          end: input.end,
          userId: reportUser.reportingUserId,
        }),
      ),
    ),
  ]);

  return applyDailyUsageCategories(
    fillDailyRows(
      input.start,
      input.end,
      sumDailyUsageRows(reports.flatMap((report) => report.results.map(toDailyUsageRow))),
    ),
    categoryRowsByUser.flat(),
  );
}

export async function getGoatUsageDrilldown(input: GoatUsageUserInput & {
  apiKey: string;
  currentUserWorkosId?: string;
  day: string;
}) {
  const reportUsers = gatewayReportUsers(input);
  if (reportUsers.length === 0) throw new Error("Could not build Goat Gateway reporting user.");
  const currentUserWorkosId = input.currentUserWorkosId ?? reportUsers[0]?.userWorkosId ?? "";

  const reports = await Promise.all(
    reportUsers.map(async (reportUser) => {
      const report = await fetchGatewayReport({
        apiKey: input.apiKey,
        start: input.day,
        end: input.day,
        groupBy: "tag",
        userId: reportUser.reportingUserId,
        tags: ["app:goat"],
      });
      return report.results
        .map((row) => toTaggedUsageRow(row, reportUser.userWorkosId))
        .flatMap((row) => {
          const context = parseContextTag(row.tag);
          return context ? [{ ...row, ...context }] : [];
        });
    }),
  );
  const rows = reports.flat();

  const labels = await loadUsageContextLabels(
    currentUserWorkosId,
    rows.filter((row) => row.userWorkosId === currentUserWorkosId),
  );
  return rows.map((row): GoatUsageDrilldownItem => {
    const key = contextKey(row.kind, row.id);
    const label = labels.get(key);
    const canLink = Boolean(label) || row.userWorkosId === currentUserWorkosId;
    return {
      tag: row.tag,
      kind: row.kind,
      id: row.id,
      label: label?.label ?? fallbackContextLabel(row.kind, row.id, { includeId: canLink }),
      href: label?.href ?? (canLink ? fallbackContextHref(row.kind, row.id) : null),
      totalCostUsdMicros: row.totalCostUsdMicros,
      requestCount: row.requestCount,
    };
  });
}

function gatewayReportUsers(input: GoatUsageUserInput): GatewayReportUser[] {
  const rawUserIds = "userWorkosIds" in input ? input.userWorkosIds : [input.userWorkosId];
  const seen = new Set<string>();
  const users: GatewayReportUser[] = [];
  for (const rawUserId of rawUserIds) {
    const userWorkosId = rawUserId.trim();
    if (!userWorkosId || seen.has(userWorkosId)) continue;
    seen.add(userWorkosId);
    const reportingUserId = goatGatewayReportingUser(userWorkosId);
    if (!reportingUserId) continue;
    users.push({ userWorkosId, reportingUserId });
  }
  return users;
}

async function fetchGatewayReport(input: {
  apiKey: string;
  start: string;
  end: string;
  groupBy: "day" | "tag";
  userId: string;
  tags: readonly string[];
}) {
  const url = new URL(VERCEL_AI_GATEWAY_REPORT_URL);
  url.searchParams.set("start_date", input.start);
  url.searchParams.set("end_date", input.end);
  url.searchParams.set("group_by", input.groupBy);
  url.searchParams.set("user_id", input.userId);
  url.searchParams.set("tags", input.tags.join(","));
  url.searchParams.set("tags_match", "all");

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${input.apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`AI Gateway report failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { results?: unknown };
  return {
    results: Array.isArray(body.results) ? (body.results as GatewayReportRow[]) : [],
  };
}

function toDailyUsageRow(row: GatewayReportRow): GoatDailyUsageRow {
  return {
    day: readString(row.day),
    totalCostUsdMicros: dollarsToMicros(row.total_cost),
    chatCostUsdMicros: 0,
    taskCostUsdMicros: 0,
    brainCostUsdMicros: 0,
    marketCostUsdMicros: dollarsToMicros(row.market_cost),
    surchargeCostUsdMicros: dollarsToMicros(row.surcharge_cost),
    gatewayCostUsdMicros: dollarsToMicros(row.gateway_cost),
    inputTokens: readNumber(row.input_tokens),
    outputTokens: readNumber(row.output_tokens),
    cachedInputTokens: readNumber(row.cached_input_tokens),
    cacheCreationInputTokens: readNumber(row.cache_creation_input_tokens),
    reasoningTokens: readNumber(row.reasoning_tokens),
    requestCount: readNumber(row.request_count),
  };
}

function sumDailyUsageRows(rows: GoatDailyUsageRow[]) {
  const byDay = new Map<string, GoatDailyUsageRow>();
  for (const row of rows) {
    if (!row.day) continue;
    const day = byDay.get(row.day) ?? emptyDailyUsageRow(row.day);
    day.totalCostUsdMicros += row.totalCostUsdMicros;
    day.chatCostUsdMicros += row.chatCostUsdMicros;
    day.taskCostUsdMicros += row.taskCostUsdMicros;
    day.brainCostUsdMicros += row.brainCostUsdMicros;
    day.marketCostUsdMicros += row.marketCostUsdMicros;
    day.surchargeCostUsdMicros += row.surchargeCostUsdMicros;
    day.gatewayCostUsdMicros += row.gatewayCostUsdMicros;
    day.inputTokens += row.inputTokens;
    day.outputTokens += row.outputTokens;
    day.cachedInputTokens += row.cachedInputTokens;
    day.cacheCreationInputTokens += row.cacheCreationInputTokens;
    day.reasoningTokens += row.reasoningTokens;
    day.requestCount += row.requestCount;
    byDay.set(row.day, day);
  }
  return Array.from(byDay.values());
}

async function fetchDailyUsageCategoryRows(input: {
  apiKey: string;
  start: string;
  end: string;
  userId: string;
}) {
  const reports = await Promise.all(
    DAILY_USAGE_CATEGORY_FEATURES.flatMap(({ category, features }) =>
      features.map(async (feature) => {
        const report = await fetchGatewayReport({
          apiKey: input.apiKey,
          start: input.start,
          end: input.end,
          groupBy: "day",
          userId: input.userId,
          tags: ["app:goat", `feature:${feature}`],
        });
        return report.results.map((row) => ({
          day: readString(row.day),
          category,
          totalCostUsdMicros: dollarsToMicros(row.total_cost),
        }));
      }),
    ),
  );

  return reports.flat();
}

function applyDailyUsageCategories(
  days: GoatDailyUsageRow[],
  categoryRows: Array<{
    day: string;
    category: (typeof DAILY_USAGE_CATEGORY_FEATURES)[number]["category"];
    totalCostUsdMicros: number;
  }>,
) {
  const byDay = new Map(days.map((day) => [day.day, { ...day }]));
  for (const row of categoryRows) {
    const day = byDay.get(row.day);
    if (!day) continue;
    day[row.category] += row.totalCostUsdMicros;
  }
  return days.map((day) => byDay.get(day.day) ?? day);
}

function toTaggedUsageRow(row: GatewayReportRow, userWorkosId: string) {
  return {
    tag: readString(row.tag),
    userWorkosId,
    totalCostUsdMicros: dollarsToMicros(row.total_cost),
    requestCount: readNumber(row.request_count),
  };
}

function fillDailyRows(start: string, end: string, rows: GoatDailyUsageRow[]) {
  const byDay = new Map(rows.filter((row) => row.day).map((row) => [row.day, row]));
  const output: GoatDailyUsageRow[] = [];
  for (const day of daysInclusive(start, end)) {
    output.push(byDay.get(day) ?? emptyDailyUsageRow(day));
  }
  return output;
}

function emptyDailyUsageRow(day: string): GoatDailyUsageRow {
  return {
    day,
    totalCostUsdMicros: 0,
    chatCostUsdMicros: 0,
    taskCostUsdMicros: 0,
    brainCostUsdMicros: 0,
    marketCostUsdMicros: 0,
    surchargeCostUsdMicros: 0,
    gatewayCostUsdMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
  };
}

function daysInclusive(start: string, end: string) {
  const days: string[] = [];
  const current = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (current <= last) {
    days.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

function parseContextTag(tag: string): { kind: "chat" | "task" | "ingest"; id: string } | null {
  const match = /^(chat|task|ingest):(.+)$/.exec(tag);
  if (!match) return null;
  const [, kind, id] = match;
  if (!kind || !id) return null;
  return { kind: kind as "chat" | "task" | "ingest", id };
}

async function loadUsageContextLabels(
  userWorkosId: string,
  rows: readonly TaggedUsageRow[],
) {
  const labels = new Map<string, { label: string; href: string | null }>();
  const chats = rows.filter((row) => row.kind === "chat").map((row) => row.id);
  const tasks = rows.filter((row) => row.kind === "task").map((row) => row.id);
  const ingests = rows.filter((row) => row.kind === "ingest").map((row) => row.id);
  const db = getDb();

  if (chats.length > 0) {
    const chatRows = await db
      .select({ id: goatChatSessions.id, title: goatChatSessions.title })
      .from(goatChatSessions)
      .where(
        and(eq(goatChatSessions.userWorkosId, userWorkosId), inArray(goatChatSessions.id, chats)),
      );
    for (const chat of chatRows) {
      labels.set(contextKey("chat", chat.id), {
        label: chat.title,
        href: `/chat/${chat.id}`,
      });
    }
  }

  if (tasks.length > 0) {
    const taskRows = await db
      .select({ id: goatTasks.id, displayId: goatTasks.displayId, name: goatTasks.name })
      .from(goatTasks)
      .where(and(eq(goatTasks.userWorkosId, userWorkosId), inArray(goatTasks.id, tasks)));
    for (const task of taskRows) {
      labels.set(contextKey("task", task.id), {
        label: `${task.displayId} ${task.name}`.trim(),
        href: `/tasks/${task.id}`,
      });
    }
  }

  if (ingests.length > 0) {
    const ingestRows = await db
      .select({
        id: goatBrainIngestJobs.id,
        sourceProvider: goatBrainIngestJobs.sourceProvider,
        status: goatBrainIngestJobs.status,
      })
      .from(goatBrainIngestJobs)
      .where(
        and(
          eq(goatBrainIngestJobs.userWorkosId, userWorkosId),
          inArray(goatBrainIngestJobs.id, ingests),
        ),
      );
    for (const ingest of ingestRows) {
      labels.set(contextKey("ingest", ingest.id), {
        label: `${ingest.sourceProvider} ingest (${ingest.status})`,
        href: null,
      });
    }
  }

  return labels;
}

function contextKey(kind: string, id: string) {
  return `${kind}:${id}`;
}

function fallbackContextLabel(
  kind: "chat" | "task" | "ingest",
  id: string,
  options: { includeId: boolean },
) {
  if (!options.includeId) {
    if (kind === "chat") return "Chat usage";
    if (kind === "task") return "Task usage";
    return "Brain ingest";
  }
  return `${kind} ${id}`;
}

function fallbackContextHref(kind: "chat" | "task" | "ingest", id: string) {
  if (kind === "chat") return `/chat/${id}`;
  if (kind === "task") return `/tasks/${id}`;
  return null;
}

function dollarsToMicros(value: unknown) {
  return Math.round(readNumber(value) * USD_MICROS_PER_DOLLAR);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
