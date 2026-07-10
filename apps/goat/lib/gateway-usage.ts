import { getDb } from "@opencompany/db/client";
import { goatBrainIngestJobs, goatChatSessions, goatTasks } from "@opencompany/db/goat-schema";
import { createGoatGatewayAttribution } from "@opencompany/goat-observability";
import { and, eq, inArray } from "drizzle-orm";

const VERCEL_AI_GATEWAY_REPORT_URL = "https://ai-gateway.vercel.sh/v1/report";
const USD_MICROS_PER_DOLLAR = 1_000_000;

export type GoatDailyUsageRow = {
  day: string;
  totalCostUsdMicros: number;
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

export async function getGoatDailyUsage(input: {
  apiKey: string;
  userWorkosId: string;
  start: string;
  end: string;
}) {
  const attribution = createGoatGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "chat",
  });
  if (!attribution.user) throw new Error("Could not build Goat Gateway reporting user.");

  const report = await fetchGatewayReport({
    apiKey: input.apiKey,
    start: input.start,
    end: input.end,
    groupBy: "day",
    userId: attribution.user,
  });

  return fillDailyRows(input.start, input.end, report.results.map(toDailyUsageRow));
}

export async function getGoatUsageDrilldown(input: {
  apiKey: string;
  userWorkosId: string;
  day: string;
}) {
  const attribution = createGoatGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "chat",
  });
  if (!attribution.user) throw new Error("Could not build Goat Gateway reporting user.");

  const report = await fetchGatewayReport({
    apiKey: input.apiKey,
    start: input.day,
    end: input.day,
    groupBy: "tag",
    userId: attribution.user,
  });
  const rows = report.results.map(toTaggedUsageRow).flatMap((row) => {
    const context = parseContextTag(row.tag);
    return context ? [{ ...row, ...context }] : [];
  });

  const labels = await loadUsageContextLabels(input.userWorkosId, rows);
  return rows.map((row): GoatUsageDrilldownItem => {
    const key = contextKey(row.kind, row.id);
    const label = labels.get(key);
    return {
      tag: row.tag,
      kind: row.kind,
      id: row.id,
      label: label?.label ?? fallbackContextLabel(row.kind, row.id),
      href: label?.href ?? fallbackContextHref(row.kind, row.id),
      totalCostUsdMicros: row.totalCostUsdMicros,
      requestCount: row.requestCount,
    };
  });
}

async function fetchGatewayReport(input: {
  apiKey: string;
  start: string;
  end: string;
  groupBy: "day" | "tag";
  userId: string;
}) {
  const url = new URL(VERCEL_AI_GATEWAY_REPORT_URL);
  url.searchParams.set("start_date", input.start);
  url.searchParams.set("end_date", input.end);
  url.searchParams.set("group_by", input.groupBy);
  url.searchParams.set("user_id", input.userId);
  url.searchParams.set("tags", "app:goat");
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

function toTaggedUsageRow(row: GatewayReportRow) {
  return {
    tag: readString(row.tag),
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
  rows: Array<{ kind: "chat" | "task" | "ingest"; id: string }>,
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

function fallbackContextLabel(kind: "chat" | "task" | "ingest", id: string) {
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
