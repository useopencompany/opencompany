import { describe, expect, it } from "vitest";
import { defaultGoatBrainIdForUser, newGoatBrainId } from "./goat-workspaces";

describe("Goat brain ids", () => {
  it("generates readable default brain ids without embedding the WorkOS user id", () => {
    const id = defaultGoatBrainIdForUser("user_01JXYZ123456789");

    expect(id).toMatch(/^general-[a-f0-9]{12}$/);
    expect(id).not.toContain("user_01JXYZ123456789");
  });

  it("prefixes new brain ids with the normalized brain name", () => {
    expect(newGoatBrainId("Customer Research")).toMatch(/^customer-research-[a-f0-9]{12}$/);
  });

  it("falls back to a generic readable prefix when the name has no slug characters", () => {
    expect(newGoatBrainId("!!!")).toMatch(/^brain-[a-f0-9]{12}$/);
  });

  it("keeps generated ids within the legacy brain document id length", () => {
    const id = newGoatBrainId("A".repeat(200));

    expect(id).toHaveLength(80);
  });
});
