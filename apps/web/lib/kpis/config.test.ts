import { describe, expect, it } from "vitest";
import { normalizeKpiMetricConfig } from "@/lib/kpis/config";
import type { KpiCatalogEntry } from "@/lib/kpis/types";

const entry: KpiCatalogEntry = {
  key: "github.pull_request_search_count",
  label: "Pull request search count",
  description: "Count pull requests matching GitHub search filters.",
  metricType: "event",
  unit: "count",
  defaultViz: "bar",
  defaultTimeRangeDays: 30,
  refreshIntervalMinutes: 30,
  configFields: [
    {
      key: "search",
      label: "Search filters",
      required: true,
      maxLength: 40,
    },
  ],
};

describe("normalizeKpiMetricConfig", () => {
  it("normalizes configured text fields", () => {
    expect(normalizeKpiMetricConfig(entry, { search: "  is:merged author:octo  " })).toEqual({
      ok: true,
      config: { search: "is:merged author:octo" },
    });
  });

  it("rejects missing required fields", () => {
    expect(normalizeKpiMetricConfig(entry, {})).toEqual({
      ok: false,
      error: "Search filters is required.",
    });
  });

  it("rejects unknown config keys", () => {
    expect(normalizeKpiMetricConfig(entry, { search: "is:merged", repo: "octo/repo" })).toEqual({
      ok: false,
      error: 'Unknown KPI option "repo".',
    });
  });

  it("rejects config for entries without fields", () => {
    const plainEntry = { ...entry, configFields: undefined };
    expect(normalizeKpiMetricConfig(plainEntry, { search: "is:merged" })).toEqual({
      ok: false,
      error: "This KPI metric does not accept custom configuration.",
    });
  });
});
