import { describe, expect, it } from "vitest";
import { renderAttioValues } from "./attio-api";

describe("renderAttioValues", () => {
  it("renders typed values to compact strings", () => {
    expect(
      renderAttioValues([
        { attribute_type: "personal-name", full_name: "Jane Doe", active_until: null },
      ]),
    ).toBe("Jane Doe");
    expect(
      renderAttioValues([
        { attribute_type: "email-address", email_address: "jane@acme.example", active_until: null },
      ]),
    ).toBe("jane@acme.example");
    expect(
      renderAttioValues([
        { attribute_type: "status", status: { title: "Closed won" }, active_until: null },
      ]),
    ).toBe("Closed won");
    expect(
      renderAttioValues([{ attribute_type: "text", value: "Enterprise", active_until: null }]),
    ).toBe("Enterprise");
  });

  it("joins first and last name when no full name exists", () => {
    expect(
      renderAttioValues([
        {
          attribute_type: "personal-name",
          first_name: "Jane",
          last_name: "Doe",
          active_until: null,
        },
      ]),
    ).toBe("Jane Doe");
  });

  it("skips inactive values, reference ids, and interaction rollups", () => {
    expect(
      renderAttioValues([
        { attribute_type: "text", value: "Old value", active_until: "2026-01-01T00:00:00Z" },
      ]),
    ).toBeNull();
    expect(
      renderAttioValues([
        {
          attribute_type: "record-reference",
          target_record_id: "rec_1",
          active_until: null,
        },
      ]),
    ).toBeNull();
    expect(
      renderAttioValues([
        { attribute_type: "interaction", value: "2026-07-16", active_until: null },
      ]),
    ).toBeNull();
  });

  it("joins multiple active values", () => {
    expect(
      renderAttioValues([
        { attribute_type: "domain", domain: "acme.com", active_until: null },
        { attribute_type: "domain", domain: "acme.io", active_until: null },
      ]),
    ).toBe("acme.com; acme.io");
  });

  it("returns null for non-array input", () => {
    expect(renderAttioValues(undefined)).toBeNull();
    expect(renderAttioValues({})).toBeNull();
  });
});
