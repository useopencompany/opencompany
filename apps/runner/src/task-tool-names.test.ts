import { describe, expect, it } from "vitest";
import { normalizeTaskToolNames } from "./task-tool-names";

describe("normalizeTaskToolNames", () => {
  it("keeps known names in catalog order without duplicates", () => {
    expect(
      normalizeTaskToolNames(["github_status", "exa_search", "github_status", "unknown_tool"]),
    ).toEqual(["exa_search", "github_status"]);
  });

  it("falls back to Exa for missing or legacy-only values", () => {
    expect(normalizeTaskToolNames(undefined)).toEqual(["exa_search"]);
    expect(normalizeTaskToolNames(["unknown_tool"])).toEqual(["exa_search"]);
  });
});
