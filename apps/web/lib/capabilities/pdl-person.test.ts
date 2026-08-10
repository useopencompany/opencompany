import { describe, expect, it } from "vitest";
import { shapePdlPersonEmailOutput } from "@/lib/capabilities/pdl-person";

describe("shapePdlPersonEmailOutput", () => {
  it("returns one compact, contactable prospect from the PDL response envelope", () => {
    expect(
      shapePdlPersonEmailOutput({
        status: 200,
        likelihood: 9,
        data: {
          id: "person-id",
          full_name: "Ada Lovelace",
          job_title: "Chief Technology Officer",
          job_title_levels: ["cxo", "cxo"],
          job_company_name: "Analytical Engines",
          location_name: "London, United Kingdom",
          linkedin_url: "http://linkedin.com/in/ada-lovelace?trk=public",
          work_email: " ada@analytical-engines.example ",
          experience: [{ company: { name: "Large payload omitted" } }],
        },
      }),
    ).toEqual({
      work_email: "ada@analytical-engines.example",
      full_name: "Ada Lovelace",
      job_title: "Chief Technology Officer",
      job_title_levels: ["cxo"],
      job_company_name: "Analytical Engines",
      location_name: "London, United Kingdom",
      linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
      likelihood: 9,
    });
  });

  it("supports Monid output that is already unwrapped", () => {
    expect(
      shapePdlPersonEmailOutput({
        work_email: "ada@example.com",
        full_name: "Ada Lovelace",
        likelihood: 10,
      }),
    ).toEqual({
      work_email: "ada@example.com",
      full_name: "Ada Lovelace",
      likelihood: 10,
    });
  });

  it("rejects a successful provider response without a usable work email", () => {
    expect(() =>
      shapePdlPersonEmailOutput({
        status: 200,
        likelihood: 8,
        data: { full_name: "Ada Lovelace", work_email: null },
      }),
    ).toThrow(/valid work email/i);
    expect(() => shapePdlPersonEmailOutput(null)).toThrow();
  });
});
