import { describe, expect, it, vi } from "vitest";
import { projectActionCatalog } from "./policy";
import type { ResolvedAction, ResolvedActionCatalog } from "./types";
import { ACTION_EFFECTS_METERED_READ, ACTION_EFFECTS_READ, ACTION_EFFECTS_WRITE } from "./types";

const action = (
  id: string,
  provider: ResolvedAction["provider"],
  effects: ResolvedAction["effects"],
  permissionMode: ResolvedAction["permissionMode"] = "on",
): ResolvedAction => ({
  id,
  provider,
  capability: id === "neon.run_sql" ? "query" : effects.mutatesExternalSystem ? "write" : "read",
  effects,
  description: id,
  params: { type: "object" },
  permissionMode,
  execute: vi.fn(),
});

const catalog: ResolvedActionCatalog = {
  providers: [
    { id: "gmail", label: "Gmail", description: "Mail" },
    { id: "neon", kind: "integration", label: "Neon", description: "Database" },
    { id: "linkedin", kind: "managed", label: "LinkedIn", description: "Research" },
  ],
  actions: [
    action("gmail.search", "gmail", ACTION_EFFECTS_READ),
    action("gmail.send", "gmail", ACTION_EFFECTS_WRITE, "ask"),
    action("neon.run_sql", "neon", ACTION_EFFECTS_READ),
    action("linkedin.search", "linkedin", ACTION_EFFECTS_METERED_READ),
  ],
};

describe("projectActionCatalog", () => {
  it("keeps On and Ask integration and managed actions for foreground chat", () => {
    expect(
      projectActionCatalog(catalog, "foregroundInteractive").actions.map(({ id }) => id),
    ).toEqual(["gmail.search", "gmail.send", "neon.run_sql", "linkedin.search"]);
  });

  it("selects cloud reads by effects and includes metered managed reads", () => {
    const projected = projectActionCatalog(catalog, "cloudReadOnly");
    expect(projected.actions.map(({ id }) => id)).toEqual([
      "gmail.search",
      "neon.run_sql",
      "linkedin.search",
    ]);
    expect(projected.providers.map(({ id }) => id)).toEqual(["gmail", "neon", "linkedin"]);
  });

  it("keeps only explicitly enabled connected integrations for headless runs", () => {
    const projected = projectActionCatalog(catalog, "headless");
    expect(projected.actions.map(({ id }) => id)).toEqual(["gmail.search", "neon.run_sql"]);
    expect(projected.providers.map(({ id }) => id)).toEqual(["gmail", "neon"]);
  });
});
