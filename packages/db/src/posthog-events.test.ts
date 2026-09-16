import { describe, expect, it } from "vitest";
import { posthogWorkflowEventContext, posthogWorkflowEventDeliveryId } from "./posthog-events";

describe("PostHog workflow events", () => {
  it("uses the immutable PostHog UUID as its delivery identity", () => {
    expect(posthogWorkflowEventDeliveryId("3e7f")).toBe("event:3e7f");
  });

  it("bounds untrusted properties and omits person mutation payloads", () => {
    const context = posthogWorkflowEventContext({
      uuid: "event-uuid",
      event: "signup",
      distinctId: "user-42",
      timestamp: "2026-09-16T10:00:00.000Z",
      createdAt: "2026-09-16T10:01:00.000Z",
      properties: {
        plan: "pro",
        $set: { email: "private@example.com" },
        $set_once: { first_seen: true },
      },
    });
    const body = context.lines.join("\n");
    expect(context.tag).toBe("posthog_event_context");
    expect(body).toContain("Event: signup");
    expect(body).toContain('"plan": "pro"');
    expect(body).not.toContain("private@example.com");
    expect(body).not.toContain("$set_once");
  });
});
