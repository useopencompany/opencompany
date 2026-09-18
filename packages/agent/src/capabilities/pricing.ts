import {
  getPluginDailySpendLimitUsdMicros,
  listInstalledPluginPricing,
  startOfUtcDay,
  sumPluginDailySpendUsdMicros,
} from "@opencompany/db/plugin-pricing";
import { ActionExecutionError } from "../actions/types";
import type { ManagedCapabilityMonidActionSpec } from "./catalog";
import {
  isLeadResearchAction,
  LEAD_RESEARCH_PLUGIN_NAME,
  type ManagedCapabilityPrice,
  priceManagedCapabilityActions,
} from "./lead-research";

export type ManagedCapabilityPriceReader = {
  workspaceId: string;
  userWorkosId: string;
};

/**
 * List prices for the paid plugins this user has installed, keyed by managed capability action id.
 * Prices come from the installed package, so a workspace bills at what it installed rather than at
 * whatever the catalog currently pins.
 */
export async function loadManagedCapabilityPrices(
  input: ManagedCapabilityPriceReader,
): Promise<Map<string, ManagedCapabilityPrice>> {
  const installed = await listInstalledPluginPricing({
    workspaceId: input.workspaceId,
    userId: input.userWorkosId,
    pluginNames: [LEAD_RESEARCH_PLUGIN_NAME],
  });
  const priced = new Map<string, ManagedCapabilityPrice>();
  for (const entry of installed) {
    for (const [actionId, price] of priceManagedCapabilityActions({
      pluginName: entry.pluginName,
      prices: entry.pricing.actions,
    })) {
      priced.set(actionId, price);
    }
  }
  return priced;
}

/** True when the action may only run through an installed paid plugin. */
export function requiresPaidPlugin(spec: ManagedCapabilityMonidActionSpec) {
  return isLeadResearchAction(spec);
}

export async function resolveManagedCapabilityPrice(input: {
  spec: ManagedCapabilityMonidActionSpec;
  workspaceId: string;
  userWorkosId: string;
}): Promise<ManagedCapabilityPrice | null> {
  if (!requiresPaidPlugin(input.spec)) return null;
  const price = (await loadManagedCapabilityPrices(input)).get(input.spec.id);
  if (!price) {
    throw new ActionExecutionError(
      "disabled",
      "This action needs the Lead research plugin installed for the workspace.",
    );
  }
  return price;
}

export type PluginDailySpendState = {
  limitUsdMicros: number;
  spentUsdMicros: number;
  remainingUsdMicros: number;
};

/** Null when the workspace has set no daily limit for the plugin. */
export async function loadPluginDailySpend(input: {
  workspaceId: string;
  pluginName: string;
  now: Date;
}): Promise<PluginDailySpendState | null> {
  const limitUsdMicros = await getPluginDailySpendLimitUsdMicros({
    workspaceId: input.workspaceId,
    pluginName: input.pluginName,
  });
  if (limitUsdMicros === null) return null;
  const spentUsdMicros = await sumPluginDailySpendUsdMicros({
    workspaceId: input.workspaceId,
    pluginName: input.pluginName,
    since: startOfUtcDay(input.now),
  });
  return {
    limitUsdMicros,
    spentUsdMicros,
    remainingUsdMicros: Math.max(0, limitUsdMicros - spentUsdMicros),
  };
}

/**
 * Rejects a run whose maximum quoted cost would take the plugin past its daily ceiling. The limit
 * is a hard stop the workspace set, so it is never offered as an approval: approving it would
 * defeat the control.
 */
export async function assertWithinPluginDailyLimit(input: {
  price: ManagedCapabilityPrice;
  quoteTotalCostUsdMicros: number;
  workspaceId: string;
  now: Date;
}) {
  const spend = await loadPluginDailySpend({
    workspaceId: input.workspaceId,
    pluginName: input.price.pluginName,
    now: input.now,
  });
  if (!spend) return;
  if (input.quoteTotalCostUsdMicros > spend.remainingUsdMicros) {
    throw new ActionExecutionError(
      "disabled",
      `This lookup would pass the daily spending limit for this plugin (${formatUsd(spend.limitUsdMicros)} per day, ${formatUsd(spend.remainingUsdMicros)} left). Tell the user, and do not retry today unless they raise the limit.`,
    );
  }
}

function formatUsd(usdMicros: number) {
  return `$${(usdMicros / 1_000_000).toFixed(2)}`;
}
