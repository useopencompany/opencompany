import { describe, expect, it } from "vitest";
import { MANAGED_CAPABILITY_ACTIONS } from "./catalog";
import {
  billedPriceUnits,
  isLeadResearchAction,
  LEAD_RESEARCH_PLUGIN_NAME,
  priceManagedCapabilityActions,
} from "./lead-research";

describe("priceManagedCapabilityActions", () => {
  it("binds declared action names to reviewed capability action ids", () => {
    const priced = priceManagedCapabilityActions({
      pluginName: LEAD_RESEARCH_PLUGIN_NAME,
      prices: [
        {
          action: "search_prospects",
          label: "Prospect found",
          unit: "per_result",
          amountUsdMicros: 80_000,
        },
      ],
    });
    expect(priced.get("lead.search_prospects")).toEqual({
      pluginName: LEAD_RESEARCH_PLUGIN_NAME,
      label: "Prospect found",
      unit: "per_result",
      amountUsdMicros: 80_000,
    });
  });

  it("drops an action the runtime does not implement", () => {
    const priced = priceManagedCapabilityActions({
      pluginName: LEAD_RESEARCH_PLUGIN_NAME,
      prices: [
        { action: "invent_leads", label: "Lead", unit: "per_result", amountUsdMicros: 80_000 },
      ],
    });
    expect(priced.size).toBe(0);
  });

  it("covers every action the shipped package prices", () => {
    // Guards the binding against a rename on either side: an unmapped priced action would
    // silently disappear from the catalog.
    const shipped = [
      "search_prospects",
      "list_company_employees",
      "search_people_by_name",
      "get_linkedin_contact",
      "find_person_email",
    ];
    const priced = priceManagedCapabilityActions({
      pluginName: LEAD_RESEARCH_PLUGIN_NAME,
      prices: shipped.map((action) => ({
        action,
        label: "Result",
        unit: "per_result" as const,
        amountUsdMicros: 1_000,
      })),
    });
    expect(priced.size).toBe(shipped.length);
    for (const actionId of priced.keys()) {
      expect(MANAGED_CAPABILITY_ACTIONS.some((spec) => spec.id === actionId)).toBe(true);
    }
  });
});

describe("isLeadResearchAction", () => {
  it("separates plugin-sold prospecting actions from free managed ones", () => {
    const specs = new Map(MANAGED_CAPABILITY_ACTIONS.map((spec) => [spec.id, spec]));
    expect(isLeadResearchAction(specs.get("lead.search_prospects") as never)).toBe(true);
    expect(isLeadResearchAction(specs.get("youtube.search") as never)).toBe(false);
  });
});

describe("billedPriceUnits", () => {
  it("bills one unit per invocation for a per-call price", () => {
    expect(billedPriceUnits({ unit: "per_call", maxUnits: 25, resultCount: 25 })).toBe(1);
  });

  it("bills the returned record count for a per-result price", () => {
    expect(billedPriceUnits({ unit: "per_result", maxUnits: 25, resultCount: 7 })).toBe(7);
  });

  it("never bills past the quoted maximum", () => {
    expect(billedPriceUnits({ unit: "per_result", maxUnits: 25, resultCount: 400 })).toBe(25);
  });

  it("bills a single unit when the provider reports no count", () => {
    expect(billedPriceUnits({ unit: "per_result", maxUnits: 25, resultCount: null })).toBe(1);
    expect(billedPriceUnits({ unit: "per_result", maxUnits: 25, resultCount: undefined })).toBe(1);
  });

  it("bills nothing when the provider explicitly found no results", () => {
    expect(billedPriceUnits({ unit: "per_result", maxUnits: 25, resultCount: 0 })).toBe(0);
    expect(billedPriceUnits({ unit: "per_call", maxUnits: 1, resultCount: 0 })).toBe(0);
  });
});
