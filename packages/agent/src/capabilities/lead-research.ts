import type { PluginActionPrice } from "@opencompany/core";
import type { ManagedCapabilityMonidActionSpec } from "./catalog";

// The Lead research plugin is the user-facing container for opencompany's paid prospecting
// actions. It carries no MCP server: its tools are the managed capability actions below, executed
// server-side. The plugin package owns the price table; this module owns the binding from a
// declared action name to the reviewed capability spec that runs it.
export const LEAD_RESEARCH_PLUGIN_NAME = "lead-research";

// Declared action names are bare tool names, as in `so.opencompany.capabilities`. Each maps to the
// managed capability action id the agent sees.
const LEAD_RESEARCH_ACTION_IDS: Record<string, string> = {
  search_prospects: "lead.search_prospects",
  list_company_employees: "lead.list_company_employees",
  search_people_by_name: "lead.search_people_by_name",
  get_linkedin_contact: "lead.get_linkedin_contact",
  find_person_email: "lead.find_person_email",
};

export const LEAD_RESEARCH_ACTION_ID_SET = new Set(Object.values(LEAD_RESEARCH_ACTION_IDS));

export type ManagedCapabilityPrice = {
  pluginName: string;
  label: string;
  unit: PluginActionPrice["unit"];
  amountUsdMicros: number;
};

/** True when a reviewed capability action is sold through the Lead research plugin. */
export function isLeadResearchAction(spec: ManagedCapabilityMonidActionSpec) {
  return LEAD_RESEARCH_ACTION_ID_SET.has(spec.id);
}

/**
 * Resolves the charged price for each capability action a paid plugin sells. An action the
 * installed package does not price is omitted, which keeps it out of the catalog entirely: an
 * unpriced paid action would otherwise execute for free against a provider that still bills us.
 */
export function priceManagedCapabilityActions(input: {
  pluginName: string;
  prices: readonly PluginActionPrice[];
}): Map<string, ManagedCapabilityPrice> {
  const priced = new Map<string, ManagedCapabilityPrice>();
  for (const price of input.prices) {
    const actionId = LEAD_RESEARCH_ACTION_IDS[price.action];
    if (!actionId) continue;
    priced.set(actionId, {
      pluginName: input.pluginName,
      label: price.label,
      unit: price.unit,
      amountUsdMicros: price.amountUsdMicros,
    });
  }
  return priced;
}

/**
 * Billed units for a run. A paid plugin sells results, so a lookup the provider explicitly
 * answered with nothing bills nothing, whatever its unit. Otherwise a `per_call` price bills one
 * unit per invocation and a `per_result` price bills one per record, never past the quoted
 * maximum. An absent count means the provider did not report one, not that it found nothing.
 */
export function billedPriceUnits(input: {
  unit: ManagedCapabilityPrice["unit"];
  maxUnits: number;
  resultCount: number | null | undefined;
}) {
  if (input.resultCount === 0) return 0;
  if (input.unit === "per_call") return 1;
  return Math.min(Math.max(input.resultCount ?? 1, 1), input.maxUnits);
}
