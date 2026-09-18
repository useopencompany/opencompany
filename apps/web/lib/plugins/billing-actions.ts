"use server";

import type { PluginBillingDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { PLUGIN_DAILY_LIMIT_MAX_USD } from "@/lib/plugins/billing";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export async function getPluginBillingAction(pluginName: string): Promise<PluginBillingDto> {
  const response = await (await serverApiClient()).v1.plugins[":name"].billing.$get({
    param: { name: pluginName },
  });
  if (!response.ok) throw new Error("Plugin billing details could not be loaded.");
  return (await response.json()).data;
}

export async function setPluginDailySpendLimitAction(input: {
  pluginName: string;
  dailyLimitUsd: number | null;
}) {
  if (
    !input?.pluginName ||
    (input.dailyLimitUsd !== null &&
      (typeof input.dailyLimitUsd !== "number" ||
        !Number.isFinite(input.dailyLimitUsd) ||
        input.dailyLimitUsd <= 0 ||
        input.dailyLimitUsd > PLUGIN_DAILY_LIMIT_MAX_USD))
  ) {
    return {
      ok: false as const,
      error: `Enter a daily limit between $0.01 and $${PLUGIN_DAILY_LIMIT_MAX_USD.toLocaleString("en-US")}.`,
    };
  }
  try {
    const response = await (await serverApiClient()).v1.plugins[":name"].billing[
      "daily-limit"
    ].$put({
      param: { name: input.pluginName },
      json: { dailyLimitUsd: input.dailyLimitUsd },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not update the daily spending limit."),
      };
    }
    const data = (await response.json()).data;
    revalidatePath(`/plugins/${input.pluginName}`);
    return { ok: true as const, billing: data };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not update the daily spending limit.",
    };
  }
}
