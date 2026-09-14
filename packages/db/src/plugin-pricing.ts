import type { PluginPricing } from "@opencompany/core";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { type PluginReader, pluginAccess } from "./plugin-access";
import { capabilityRuns, pluginSpendLimits, plugins } from "./product-schema";

type DbLike = any;

export type InstalledPluginPricing = {
  pluginName: string;
  pricing: PluginPricing;
};

/**
 * Enabled, accessible plugins that carry a reviewed price table. Pricing is stored per
 * installation, so a workspace keeps billing at the prices it installed until it updates.
 */
export async function listInstalledPluginPricing(
  input: PluginReader & { pluginNames?: readonly string[]; db?: DbLike },
): Promise<InstalledPluginPricing[]> {
  const db = input.db ?? getDb();
  const rows = await db
    .select({ pluginName: plugins.name, pricing: plugins.pricing })
    .from(plugins)
    .where(
      and(
        eq(plugins.status, "enabled"),
        pluginAccess(input),
        sql`${plugins.pricing} IS NOT NULL`,
        input.pluginNames?.length ? inArray(plugins.name, [...input.pluginNames]) : undefined,
      ),
    );
  return rows.flatMap((row: { pluginName: string; pricing: PluginPricing | null }) =>
    row.pricing ? [{ pluginName: row.pluginName, pricing: row.pricing }] : [],
  );
}

export async function getPluginDailySpendLimitUsdMicros(input: {
  workspaceId: string;
  pluginName: string;
  db?: DbLike;
}): Promise<number | null> {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({ dailyLimitUsdMicros: pluginSpendLimits.dailyLimitUsdMicros })
    .from(pluginSpendLimits)
    .where(
      and(
        eq(pluginSpendLimits.workspaceId, input.workspaceId),
        eq(pluginSpendLimits.pluginName, input.pluginName),
      ),
    )
    .limit(1);
  return row?.dailyLimitUsdMicros ?? null;
}

export async function setPluginDailySpendLimit(input: {
  workspaceId: string;
  pluginName: string;
  dailyLimitUsdMicros: number | null;
  updatedByWorkosId: string;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  if (input.dailyLimitUsdMicros === null) {
    await db
      .delete(pluginSpendLimits)
      .where(
        and(
          eq(pluginSpendLimits.workspaceId, input.workspaceId),
          eq(pluginSpendLimits.pluginName, input.pluginName),
        ),
      );
    return null;
  }
  if (!Number.isSafeInteger(input.dailyLimitUsdMicros) || input.dailyLimitUsdMicros <= 0) {
    throw new Error("A daily spend limit must be a positive whole number of USD micros.");
  }
  const now = new Date();
  const [row] = await db
    .insert(pluginSpendLimits)
    .values({
      workspaceId: input.workspaceId,
      pluginName: input.pluginName,
      dailyLimitUsdMicros: input.dailyLimitUsdMicros,
      updatedByWorkosId: input.updatedByWorkosId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [pluginSpendLimits.workspaceId, pluginSpendLimits.pluginName],
      set: {
        dailyLimitUsdMicros: input.dailyLimitUsdMicros,
        updatedByWorkosId: input.updatedByWorkosId,
        updatedAt: now,
      },
    })
    .returning({ dailyLimitUsdMicros: pluginSpendLimits.dailyLimitUsdMicros });
  if (!row) throw new Error("Could not update the plugin spend limit.");
  return row.dailyLimitUsdMicros;
}

/** Start of the current UTC day. The limit is a calendar-day cap, not a rolling window. */
export function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Spend attributed to a plugin so far today, counting in-flight runs at their quote. Runs that
 * never reached a provider (awaiting approval, canceled, expired) are excluded, so an untouched
 * approval card does not consume the day's budget.
 */
export async function sumPluginDailySpendUsdMicros(input: {
  workspaceId: string;
  pluginName: string;
  since: Date;
  db?: DbLike;
}) {
  const db = input.db ?? getDb();
  const [row] = await db
    .select({
      totalUsdMicros: sql<number>`coalesce(sum(coalesce(${capabilityRuns.totalCostUsdMicros}, ${capabilityRuns.quoteTotalCostUsdMicros})), 0)::bigint`,
    })
    .from(capabilityRuns)
    .where(
      and(
        eq(capabilityRuns.workspaceId, input.workspaceId),
        eq(capabilityRuns.pluginName, input.pluginName),
        gte(capabilityRuns.createdAt, input.since),
        sql`${capabilityRuns.status} NOT IN ('awaiting_approval', 'canceled', 'expired')`,
      ),
    );
  return Number(row?.totalUsdMicros ?? 0);
}
