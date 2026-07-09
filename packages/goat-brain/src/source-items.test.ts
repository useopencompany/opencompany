import { describe, expect, it } from "vitest";
import {
  BrainSourceNormalizationError,
  isNormalizedGoatChatCaptureSourceItem,
  normalizeGoatChatCapture,
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

    expect(item.sourceProvider).toBe("jamie");
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

describe("Goat chat capture normalization", () => {
  function captureInput(overrides: Record<string, unknown> = {}) {
    return {
      text: "Check out https://example.com/pricing-teardown for the pricing rework.",
      title: "Pricing teardown reference",
      intent: "reference for the pricing page rework",
      chatSessionId: "goat_chat_session_1",
      userMessageId: "goat_chat_msg_1",
      draftBrainId: "pricing-teardown-reference",
      draftFolder: "inbox",
      capturedAt: "2026-07-09T10:00:00.000Z",
      ...overrides,
    };
  }

  it("normalizes a chat capture", () => {
    const item = normalizeGoatChatCapture(captureInput());

    expect(item).toMatchObject({
      sourceProvider: "goat-chat",
      sourceType: "capture",
      externalId: "pricing-teardown-reference",
      sourceRef: "goat-chat:goat_chat_msg_1",
      title: "Pricing teardown reference",
      occurredAt: "2026-07-09T10:00:00.000Z",
      capturedAt: "2026-07-09T10:00:00.000Z",
    });
    expect(item.content.capture).toMatchObject({
      text: "Check out https://example.com/pricing-teardown for the pricing rework.",
      intent: "reference for the pricing page rework",
      chatSessionId: "goat_chat_session_1",
      userMessageId: "goat_chat_msg_1",
      draftBrainId: "pricing-teardown-reference",
      draftFolder: "inbox",
    });
    expect(isNormalizedGoatChatCaptureSourceItem(item)).toBe(true);
    expect(isNormalizedGoatChatCaptureSourceItem(JSON.parse(JSON.stringify(item)))).toBe(true);
  });

  it("derives stable content hashes and changes them when the text changes", () => {
    const first = normalizeGoatChatCapture(captureInput());
    const second = normalizeGoatChatCapture(captureInput());
    const changed = normalizeGoatChatCapture(captureInput({ text: "Different idea." }));

    expect(second.contentHash).toBe(first.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("omits an empty intent", () => {
    const item = normalizeGoatChatCapture(captureInput({ intent: "  " }));
    expect(item.content.capture.intent).toBeUndefined();
  });

  it.each([
    ["text", { text: "  " }],
    ["title", { title: "" }],
    ["chat session", { chatSessionId: " " }],
    ["message", { userMessageId: "" }],
    ["draft id", { draftBrainId: "" }],
    ["timestamp", { capturedAt: "not-a-date" }],
  ])("rejects an invalid %s", (_field, override) => {
    expect(() => normalizeGoatChatCapture(captureInput(override))).toThrow(
      BrainSourceNormalizationError,
    );
  });

  it("rejects non-capture payloads in the guard", () => {
    expect(isNormalizedGoatChatCaptureSourceItem(null)).toBe(false);
    expect(isNormalizedGoatChatCaptureSourceItem({ sourceProvider: "goat-chat" })).toBe(false);
    expect(
      isNormalizedGoatChatCaptureSourceItem(normalizeJamieMeetingCompletedWebhook(jamiePayload())),
    ).toBe(false);
  });
});
