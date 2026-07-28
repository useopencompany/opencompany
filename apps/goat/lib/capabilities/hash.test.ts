import { describe, expect, it } from "vitest";
import { hashCapabilityInput } from "@/lib/capabilities/hash";

describe("hashCapabilityInput", () => {
  it("is stable across object key order and changes for any bound parameter", () => {
    const first = hashCapabilityInput({
      action: "lead.find_person_email",
      params: { company: "Analytical Engines", name: "Ada Lovelace" },
    });
    const reordered = hashCapabilityInput({
      params: { name: "Ada Lovelace", company: "Analytical Engines" },
      action: "lead.find_person_email",
    });
    const changed = hashCapabilityInput({
      action: "lead.find_person_email",
      params: { company: "Different Company", name: "Ada Lovelace" },
    });
    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
