import { describe, expect, it } from "vitest";
import {
  BrainSourceNormalizationError,
  normalizeJamieMeetingCompletedWebhook,
} from "./source-items";

function jamiePayload(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      event: "meeting.completed",
      created: "2026-01-01T11:05:00.000Z",
    },
    data: {
      user: {
        id: "user_123",
        email: "founder@example.com",
      },
      event: {
        id: "meeting_123",
        externalId: "calendar_event_123",
        title: "Product Review",
        startTime: "2026-01-01T10:00:00.000Z",
        endTime: "2026-01-01T11:00:00.000Z",
        summary: {
          markdown: "We reviewed the new onboarding flow.",
        },
        participants: [{ id: "person_1", name: "Jamie", email: "jamie@example.com" }, "Alex"],
        actionItems: [{ text: "Ship the prototype", assignee: "Jamie" }],
        transcript: [
          {
            speakerName: "Jamie",
            startTime: "00:00:01",
            text: "Let's review the onboarding flow.",
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("Jamie brain source normalization", () => {
  it("normalizes a meeting.completed payload", () => {
    const item = normalizeJamieMeetingCompletedWebhook(jamiePayload(), {
      capturedAt: "2026-01-01T11:06:00.000Z",
    });

    expect(item.provider).toBe("jamie");
    expect(item.sourceType).toBe("meeting");
    expect(item.externalId).toBe("calendar_event_123");
    expect(item.sourceRef).toBe("jamie:meeting:calendar_event_123");
    expect(item.title).toBe("Product Review");
    expect(item.occurredAt).toBe("2026-01-01T10:00:00.000Z");
    expect(item.capturedAt).toBe("2026-01-01T11:06:00.000Z");
    expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(item.content.meeting.summaryMarkdown).toBe("We reviewed the new onboarding flow.");
    expect(item.content.meeting.participants).toHaveLength(2);
    expect(item.content.meeting.actionItems).toEqual([
      { text: "Ship the prototype", assignee: "Jamie" },
    ]);
  });

  it("falls back to Jamie event id when external id is missing", () => {
    const payload = jamiePayload({
      data: {
        user: { id: "user_123" },
        event: {
          ...jamiePayload().data.event,
          externalId: undefined,
        },
      },
    });

    const item = normalizeJamieMeetingCompletedWebhook(payload);

    expect(item.externalId).toBe("meeting_123");
  });

  it("derives a stable external id when Jamie ids are missing", () => {
    const payload = jamiePayload({
      data: {
        user: { id: "user_123" },
        event: {
          ...jamiePayload().data.event,
          id: undefined,
          externalId: undefined,
        },
      },
    });

    const first = normalizeJamieMeetingCompletedWebhook(payload);
    const second = normalizeJamieMeetingCompletedWebhook(payload);

    expect(first.externalId).toMatch(/^derived-[a-f0-9]{32}$/);
    expect(second.externalId).toBe(first.externalId);
  });

  it("derives stable content hashes from normalized content", () => {
    const first = normalizeJamieMeetingCompletedWebhook(jamiePayload());
    const second = normalizeJamieMeetingCompletedWebhook(jamiePayload());
    const changed = normalizeJamieMeetingCompletedWebhook(
      jamiePayload({
        data: {
          user: { id: "user_123" },
          event: {
            ...jamiePayload().data.event,
            summary: "Different summary",
          },
        },
      }),
    );

    expect(second.contentHash).toBe(first.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it.each([
    ["event", { metadata: { event: "meeting.started" } }],
    [
      "title",
      { data: { user: { id: "user_123" }, event: { ...jamiePayload().data.event, title: "" } } },
    ],
    [
      "start time",
      {
        data: {
          user: { id: "user_123" },
          event: { ...jamiePayload().data.event, startTime: "not-a-date" },
        },
      },
    ],
    ["user", { data: { user: {}, event: jamiePayload().data.event } }],
    [
      "summary",
      { data: { user: { id: "user_123" }, event: { ...jamiePayload().data.event, summary: {} } } },
    ],
    [
      "transcript",
      {
        data: { user: { id: "user_123" }, event: { ...jamiePayload().data.event, transcript: [] } },
      },
    ],
  ])("rejects invalid %s shape", (_field, override) => {
    expect(() => normalizeJamieMeetingCompletedWebhook(jamiePayload(override))).toThrow(
      BrainSourceNormalizationError,
    );
  });
});
