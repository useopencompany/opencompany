import { describe, expect, it } from "vitest";
import { GoatActionInvalidParamsError } from "@/lib/actions/types";
import { shapeCompanyEmployeesOutput } from "@/lib/capabilities/lead-company-employees";

describe("shapeCompanyEmployeesOutput", () => {
  it("returns compact people without duplicated nested company profiles", () => {
    const shaped = shapeCompanyEmployeesOutput(
      {
        employees: [
          {
            fullName: "Ada Lovelace",
            title: "Head of Brand Partnerships",
            location: "Berlin, Germany",
            profileUrl: "https://linkedin.com/in/ada-lovelace?trk=public",
            email: "ada@example.com",
            company: {
              name: "Red Bull Media House",
              url: "https://linkedin.com/company/redbullmediahouse?trk=public",
              logo: "https://cdn.example/logo.png",
              backgroundCoverImages: [{ url: "https://cdn.example/cover.png" }],
              affiliatedPages: Array.from({ length: 20 }, (_, index) => ({
                name: `Page ${index}`,
              })),
              description: "large repeated company profile",
            },
          },
        ],
      },
      {
        companyUrl: "https://www.linkedin.com/company/redbullmediahouse",
        query: "brand partnerships",
        location: "Germany",
      },
    );

    expect(shaped).toEqual({
      companyUrl: "https://www.linkedin.com/company/redbullmediahouse",
      filters: {
        query: "brand partnerships",
        location: "Germany",
      },
      employees: [
        {
          full_name: "Ada Lovelace",
          job_title: "Head of Brand Partnerships",
          location: "Berlin, Germany",
          linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
          work_email: "ada@example.com",
          company_name: "Red Bull Media House",
          company_linkedin_url: "https://www.linkedin.com/company/redbullmediahouse",
        },
      ],
    });
    expect(JSON.stringify(shaped)).not.toContain("backgroundCoverImages");
    expect(JSON.stringify(shaped)).not.toContain("affiliatedPages");
  });

  it("rejects empty company employee payloads with a canonical URL hint", () => {
    expect(() =>
      shapeCompanyEmployeesOutput(
        { employees: [] },
        {
          companyUrl: "https://www.linkedin.com/company/red-bull-media-house",
          query: "partnerships content brand",
        },
      ),
    ).toThrow(GoatActionInvalidParamsError);
    expect(() =>
      shapeCompanyEmployeesOutput([], {
        companyUrl: "https://www.linkedin.com/company/red-bull-media-house",
      }),
    ).toThrow(/canonical LinkedIn company URL/i);
  });

  it("accepts employee arrays nested under provider response envelopes", () => {
    expect(
      shapeCompanyEmployeesOutput(
        {
          data: {
            results: [
              {
                name: "Grace Hopper",
                jobTitle: "Partnerships Lead",
                linkedin_url: "https://www.linkedin.com/in/grace-hopper/",
              },
            ],
          },
        },
        { companyUrl: "https://www.linkedin.com/company/openai" },
      ).employees,
    ).toEqual([
      {
        full_name: "Grace Hopper",
        job_title: "Partnerships Lead",
        linkedin_url: "https://www.linkedin.com/in/grace-hopper/",
      },
    ]);
  });
});
