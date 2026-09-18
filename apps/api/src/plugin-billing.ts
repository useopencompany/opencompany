import type { Actor, PluginPricing } from "@opencompany/core";
import {
  getPluginDailySpendLimitUsdMicros,
  listInstalledPluginPricing,
  setPluginDailySpendLimit,
  startOfUtcDay,
  sumPluginDailySpendUsdMicros,
} from "@opencompany/db/plugin-pricing";
import { ApiError } from "./errors";

type DbLike = any;

export const PLUGIN_DAILY_LIMIT_MAX_USD = 10_000;

export type PluginBillingView = {
  pluginName: string;
  pricing: PluginPricing | null;
  dailyLimitUsdMicros: number | null;
  spentTodayUsdMicros: number;
};

export type PluginBillingService = {
  get(actor: Actor, pluginName: string): Promise<PluginBillingView>;
  setDailyLimit(
    actor: Actor,
    pluginName: string,
    dailyLimitUsd: number | null,
  ): Promise<PluginBillingView>;
};

export function createPluginBillingService(input: { db: DbLike }): PluginBillingService {
  const db = input.db;

  async function view(actor: Actor, pluginName: string): Promise<PluginBillingView> {
    const [installed, dailyLimitUsdMicros, spentTodayUsdMicros] = await Promise.all([
      listInstalledPluginPricing({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        pluginNames: [pluginName],
        db,
      }),
      getPluginDailySpendLimitUsdMicros({ workspaceId: actor.workspaceId, pluginName, db }),
      sumPluginDailySpendUsdMicros({
        workspaceId: actor.workspaceId,
        pluginName,
        since: startOfUtcDay(new Date()),
        db,
      }),
    ]);
    return {
      pluginName,
      pricing: installed[0]?.pricing ?? null,
      dailyLimitUsdMicros,
      spentTodayUsdMicros,
    };
  }

  return {
    get: view,

    async setDailyLimit(actor, pluginName, dailyLimitUsd) {
      if (actor.role !== "admin") {
        throw new ApiError(
          403,
          "forbidden",
          "Only workspace admins can change a plugin spending limit.",
        );
      }
      if (
        dailyLimitUsd !== null &&
        (!Number.isFinite(dailyLimitUsd) ||
          dailyLimitUsd <= 0 ||
          dailyLimitUsd > PLUGIN_DAILY_LIMIT_MAX_USD)
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          `Enter a daily spending limit between $0.01 and $${PLUGIN_DAILY_LIMIT_MAX_USD.toLocaleString("en-US")}.`,
        );
      }
      await setPluginDailySpendLimit({
        workspaceId: actor.workspaceId,
        pluginName,
        // Round to whole cents so the stored ceiling matches what the input showed.
        dailyLimitUsdMicros:
          dailyLimitUsd === null ? null : Math.round(dailyLimitUsd * 100) * 10_000,
        updatedByWorkosId: actor.userId,
        db,
      });
      return view(actor, pluginName);
    },
  };
}
