import { describe, expect, it } from "vitest";
import { normalizeGoatTaskToolNames } from "./goat-task-tool-names";

describe("normalizeGoatTaskToolNames", () => {
  it("keeps known names in catalog order without duplicates", () => {
    expect(
      normalizeGoatTaskToolNames(["github_status", "exa_search", "github_status", "unknown_tool"]),
    ).toEqual(["exa_search", "github_status"]);
  });

  it("falls back to Exa for missing or legacy-only values", () => {
    expect(normalizeGoatTaskToolNames(undefined)).toEqual(["exa_search"]);
    expect(normalizeGoatTaskToolNames(["unknown_tool"])).toEqual(["exa_search"]);
  });
});
