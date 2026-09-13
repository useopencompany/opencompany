import { describe, expect, it } from "vitest";
import {
  jamieMeetingGuestScope,
  jamieWorkflowEventContext,
  jamieWorkflowEventDeliveryId,
} from "./jamie";

function meeting(overrides: Record<string, unknown> = {}) {
  return {
    title: "Acme onboarding",
    startTime: "2026-09-12T14:00:00.000Z",
    user: { id: "jamie_user_1", email: "founder@northwind.co" },
    ...overrides,
  };
}

describe("jamieWorkflowEventDeliveryId", () => {
  it("is stable for the same meeting and distinct across meetings", () => {
    expect(jamieWorkflowEventDeliveryId(meeting())).toBe(jamieWorkflowEventDeliveryId(meeting()));
    expect(jamieWorkflowEventDeliveryId(meeting({ title: "Standup" }))).not.toBe(
      jamieWorkflowEventDeliveryId(meeting()),
    );
    expect(
      jamieWorkflowEventDeliveryId(meeting({ startTime: "2026-09-12T15:00:00.000Z" })),
    ).not.toBe(jamieWorkflowEventDeliveryId(meeting()));
  });

  it("separates the same meeting title recorded by different people", () => {
    expect(
      jamieWorkflowEventDeliveryId(meeting({ user: { id: "jamie_user_2", email: "b@x.com" } })),
    ).not.toBe(jamieWorkflowEventDeliveryId(meeting()));
  });
});

describe("jamieMeetingGuestScope", () => {
  it("is external when any attendee or speaker is outside the recorder's domain", () => {
    expect(
      jamieMeetingGuestScope(meeting({ event: { attendees: [{ email: "dana@acme.com" }] } })),
    ).toBe("external");
    expect(jamieMeetingGuestScope(meeting({ participants: [{ email: "dana@acme.com" }] }))).toBe(
      "external",
    );
  });

  it("ignores case and treats a meeting with only colleagues as internal", () => {
    expect(
      jamieMeetingGuestScope(
        meeting({
          event: {
            attendees: [{ email: "Founder@Northwind.co" }, { email: "eng@northwind.co" }],
          },
        }),
      ),
    ).toBe("internal");
    expect(jamieMeetingGuestScope(meeting())).toBe("internal");
  });

  it("declines to guess when the payload never names the recorder's domain", () => {
    expect(jamieMeetingGuestScope(meeting({ user: { id: "jamie_user_1" } }))).toBeNull();
  });
});

describe("jamieWorkflowEventContext", () => {
  it("carries the summary, people, action items, and tags", () => {
    const context = jamieWorkflowEventContext(
      meeting({
        summary: { markdown: "# Notes\nAcme wants SSO." },
        participants: [{ name: "Dana", email: "dana@acme.com" }],
        event: { attendees: [{ name: "Founder", email: "founder@northwind.co" }] },
        tasks: [{ content: "Send the SSO doc", assignee: { name: "Founder" } }],
        tags: [{ name: "Customer" }],
      }),
    );
    const body = context.lines.filter((line) => line !== null).join("\n");

    expect(context.tag).toBe("jamie_meeting_context");
    expect(body).toContain("Title: Acme onboarding");
    expect(body).toContain("Recorded by: founder@northwind.co");
    expect(body).toContain("Invited: Founder <founder@northwind.co>");
    expect(body).toContain("Spoke: Dana <dana@acme.com>");
    expect(body).toContain("Tags: Customer");
    expect(body).toContain("- Send the SSO doc (Founder)");
    expect(body).toContain("Acme wants SSO.");
  });

  it("falls back to the short summary and omits sections the payload lacks", () => {
    const context = jamieWorkflowEventContext(meeting({ summary: { short: "Quick sync." } }));
    const body = context.lines.filter((line) => line !== null).join("\n");

    expect(body).toContain("Quick sync.");
    expect(body).not.toContain("Invited:");
    expect(body).not.toContain("Action items");
  });
});
