import { describe, expect, it } from "vitest";
import { demoBookingUrl } from "./demo-request";

describe("demoBookingUrl", () => {
  it("preserves email aliases and qualification answers in the booking handoff", () => {
    const url = new URL(
      demoBookingUrl({
        email: " founder+demo@example.com ",
        companyType: "Small business / professional services / agency",
        teamSize: "2–10",
      }),
    );

    expect(url.origin).toBe("https://cal.com");
    expect(url.pathname).toBe("/louis-morgner-k0wc9i/opencompany-onboarding");
    expect(url.searchParams.get("email")).toBe("founder+demo@example.com");
    expect(url.searchParams.get("notes")).toBe(
      "Company type: Small business / professional services / agency\nTeam size: 2–10",
    );
  });

  it("encodes input without allowing it to override booking parameters", () => {
    const url = new URL(
      demoBookingUrl({
        email: "founder&theme=dark@example.com",
        companyType: "Other",
        teamSize: "Just me",
      }),
    );

    expect(url.searchParams.get("email")).toBe("founder&theme=dark@example.com");
    expect(url.searchParams.getAll("theme")).toEqual(["light"]);
    expect(url.searchParams.get("notes")).toBe("Company type: Other\nTeam size: Just me");
  });

  it.each([
    ["Just me", "Just me"],
    ["2–10", "2-10"],
    ["11–50", "10-50"],
    ["51–200", ">50"],
    ["201+", ">50"],
  ] as const)(
    "prefills %s using the existing calendar question's %s value",
    (teamSize, expected) => {
      const url = new URL(
        demoBookingUrl({ email: "founder@example.com", companyType: "Other", teamSize }),
      );

      expect(url.searchParams.get("how-many-people-are-on-your-team")).toBe(expected);
      expect(url.searchParams.get("metadata[teamSize]")).toBe(teamSize);
      expect(url.searchParams.get("metadata[companyType]")).toBe("Other");
    },
  );
});
