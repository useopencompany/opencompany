import { describe, expect, it } from "vitest";
import {
  BrainSourceNormalizationError,
  isNormalizedGoatChatCaptureSourceItem,
  isNormalizedLinearIssueSourceItem,
  isNormalizedSlackConversationSourceItem,
  isNormalizedUploadAssetSourceItem,
  normalizeGoatChatCapture,
  normalizeJamieMeetingCompletedWebhook,
  normalizeLinearIssueWindow,
  normalizeSlackConversationWindow,
  normalizeUploadAsset,
  slackTsToIso,
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

describe("normalizeUploadAsset", () => {
  const input = {
    documentId: "goat_brain_doc_abc",
    brainId: "q3-board-deck",
    folderPath: "sources",
    format: "pdf",
    mimeType: "application/pdf",
    originalFileName: "Q3 Board Deck.pdf",
    sizeBytes: 123_456,
    contentSha256: "a".repeat(64),
    uploadedAt: "2026-07-09T10:00:00.000Z",
  };

  it("normalizes an uploaded asset with a stable external id and source ref", () => {
    const item = normalizeUploadAsset(input);
    expect(item.sourceProvider).toBe("upload");
    expect(item.sourceType).toBe("asset");
    expect(item.externalId).toBe("goat_brain_doc_abc");
    expect(item.sourceRef).toBe("upload:goat_brain_doc_abc");
    expect(item.title).toBe("Q3 Board Deck.pdf");
    expect(item.content.asset.brainId).toBe("q3-board-deck");
    expect(isNormalizedUploadAssetSourceItem(item)).toBe(true);
    // Same bytes dedupe; different bytes re-enqueue.
    expect(normalizeUploadAsset(input).contentHash).toBe(item.contentHash);
    expect(normalizeUploadAsset({ ...input, contentSha256: "b".repeat(64) }).contentHash).not.toBe(
      item.contentHash,
    );
  });

  it("rejects malformed digests and timestamps", () => {
    expect(() => normalizeUploadAsset({ ...input, contentSha256: "nope" })).toThrow(/sha256/);
    expect(() => normalizeUploadAsset({ ...input, uploadedAt: "not-a-date" })).toThrow(/timestamp/);
    expect(() => normalizeUploadAsset({ ...input, documentId: " " })).toThrow(/documentId/);
  });

  it("guards against other item shapes", () => {
    expect(isNormalizedUploadAssetSourceItem({ sourceProvider: "upload" })).toBe(false);
    expect(isNormalizedUploadAssetSourceItem(null)).toBe(false);
  });
});

describe("Slack conversation window normalization", () => {
  const input = {
    windowId: "gslkwin_abc123",
    teamId: "T012345",
    teamDomain: "acme",
    channelId: "C09ABC",
    channelName: "product",
    channelType: "channel" as const,
    messages: [
      {
        ts: "1783950120.000200",
        userId: "U02",
        userName: "Alex",
        text: "We decided to ship the new onboarding flow next week.",
      },
      {
        ts: "1783950060.000100",
        userId: "U01",
        userName: "Jamie",
        text: "Where did we land on onboarding?",
      },
      {
        ts: "1783950180.000300",
        threadTs: "1783950120.000200",
        userId: "U01",
        text: "Great, I'll tell the team.",
      },
    ],
    flushedAt: "2026-07-13T10:30:00.000Z",
  };

  it("normalizes a window and sorts messages by ts", () => {
    const item = normalizeSlackConversationWindow(input);

    expect(item.sourceProvider).toBe("slack");
    expect(item.sourceType).toBe("conversation");
    expect(item.externalId).toBe("gslkwin_abc123");
    expect(item.sourceRef).toBe("slack:conversation:T012345:C09ABC:1783950180.000300");
    expect(item.title).toContain("#product");
    expect(item.content.conversation.windowStartTs).toBe("1783950060.000100");
    expect(item.content.conversation.windowEndTs).toBe("1783950180.000300");
    expect(item.content.conversation.messages.map((message) => message.userId)).toEqual([
      "U01",
      "U02",
      "U01",
    ]);
    expect(item.occurredAt).toBe(slackTsToIso("1783950060.000100"));
    expect(item.capturedAt).toBe("2026-07-13T10:30:00.000Z");
    expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(isNormalizedSlackConversationSourceItem(item)).toBe(true);
  });

  it("hashes only message identity, not enrichment", () => {
    const base = normalizeSlackConversationWindow(input);
    const renamed = normalizeSlackConversationWindow({
      ...input,
      channelName: "product-renamed",
      messages: input.messages.map(({ userName: _userName, ...message }) => message),
    });
    expect(renamed.contentHash).toBe(base.contentHash);
    const edited = normalizeSlackConversationWindow({
      ...input,
      messages: [{ ...input.messages[0]!, text: "changed" }, ...input.messages.slice(1)],
    });
    expect(edited.contentHash).not.toBe(base.contentHash);
  });

  it("accepts sorted previous and thread context without changing the content hash", () => {
    const base = normalizeSlackConversationWindow(input);
    const withContext = normalizeSlackConversationWindow({
      ...input,
      context: {
        previousMessages: [
          {
            ts: "1783949940.000050",
            userId: "U02",
            text: "Previous answer.",
          },
          {
            ts: "1783949880.000040",
            userId: "U01",
            text: "Previous question.",
          },
        ],
        threads: [
          {
            threadTs: "1783950120.000200",
            messages: [
              {
                ts: "1783950000.000090",
                threadTs: "1783950120.000200",
                userId: "U03",
                text: "Earlier thread context.",
              },
            ],
          },
        ],
      },
    });

    expect(withContext.contentHash).toBe(base.contentHash);
    expect(
      withContext.content.conversation.context?.previousMessages?.map((message) => message.ts),
    ).toEqual(["1783949880.000040", "1783949940.000050"]);
    expect(withContext.content.conversation.context?.threads?.[0]?.messages).toHaveLength(1);
    expect(isNormalizedSlackConversationSourceItem(withContext)).toBe(true);
  });

  it("titles DM windows after the counterpart", () => {
    const item = normalizeSlackConversationWindow({
      ...input,
      channelType: "im",
      channelName: "Jamie",
    });
    expect(item.title).toContain("DM with Jamie");
  });

  it("rejects empty windows and malformed input", () => {
    expect(() => normalizeSlackConversationWindow({ ...input, messages: [] })).toThrow(
      BrainSourceNormalizationError,
    );
    expect(() => normalizeSlackConversationWindow({ ...input, windowId: " " })).toThrow(/windowId/);
    expect(() => normalizeSlackConversationWindow({ ...input, flushedAt: "nope" })).toThrow(
      /timestamp/,
    );
  });

  it("guards against other item shapes", () => {
    expect(isNormalizedSlackConversationSourceItem({ sourceProvider: "slack" })).toBe(false);
    expect(isNormalizedSlackConversationSourceItem(null)).toBe(false);
  });
});

describe("Linear issue window normalization", () => {
  const input = {
    windowId: "glinwin_abc123",
    organizationId: "org_9f2c",
    issueId: "issue_1234",
    identifier: "ENG-42",
    url: "https://linear.app/acme/issue/ENG-42",
    title: "Checkout crashes on retry",
    teamId: "team_77",
    teamKey: "ENG",
    teamName: "Engineering",
    state: "In Progress",
    stateType: "started",
    assigneeName: "Ada",
    activity: [
      {
        occurredAt: "2026-07-13T10:05:00.000Z",
        entityType: "comment" as const,
        action: "create" as const,
        actorName: "Ada",
        commentId: "cmt_2",
        commentBody: "Root cause is a double-submit race.",
      },
      {
        occurredAt: "2026-07-13T10:00:00.000Z",
        entityType: "issue" as const,
        action: "update" as const,
        actorName: "Ada",
        changedFields: ["state"],
      },
    ],
    comments: [
      {
        id: "cmt_2",
        body: "Root cause is a double-submit race.",
        authorName: "Ada",
        createdAt: "2026-07-13T10:05:00.000Z",
      },
    ],
    flushedAt: "2026-07-13T10:30:00.000Z",
  };

  it("normalizes a window and sorts activity by time", () => {
    const item = normalizeLinearIssueWindow(input);

    expect(item.sourceProvider).toBe("linear");
    expect(item.sourceType).toBe("issue");
    expect(item.externalId).toBe("glinwin_abc123");
    expect(item.sourceRef).toBe("linear:issue:ENG-42");
    expect(item.title).toBe("ENG-42 Checkout crashes on retry");
    expect(item.content.issue.windowStart).toBe("2026-07-13T10:00:00.000Z");
    expect(item.content.issue.windowEnd).toBe("2026-07-13T10:05:00.000Z");
    expect(item.content.issue.activity.map((entry) => entry.entityType)).toEqual([
      "issue",
      "comment",
    ]);
    expect(item.occurredAt).toBe("2026-07-13T10:00:00.000Z");
    expect(item.capturedAt).toBe("2026-07-13T10:30:00.000Z");
    expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(isNormalizedLinearIssueSourceItem(item)).toBe(true);
  });

  it("hashes activity identity and state, not enrichment", () => {
    const base = normalizeLinearIssueWindow(input);
    const enriched = normalizeLinearIssueWindow({
      ...input,
      assigneeName: "Grace",
      description: "New description that should not affect the hash.",
    });
    expect(enriched.contentHash).toBe(base.contentHash);
    const stateChanged = normalizeLinearIssueWindow({ ...input, state: "Done" });
    expect(stateChanged.contentHash).not.toBe(base.contentHash);
  });

  it("falls back to the issue id when the live snapshot is unavailable", () => {
    const item = normalizeLinearIssueWindow({
      windowId: "glinwin_stale",
      organizationId: "org_9f2c",
      issueId: "issue_1234",
      title: "Checkout crashes on retry",
      activity: input.activity,
      snapshotStale: true,
      flushedAt: "2026-07-13T10:30:00.000Z",
    });
    expect(item.sourceRef).toBe("linear:issue:issue_1234");
    expect(item.title).toBe("Checkout crashes on retry");
    expect(item.content.issue.snapshotStale).toBe(true);
    expect(isNormalizedLinearIssueSourceItem(item)).toBe(true);
  });

  it("rejects empty windows and malformed input", () => {
    expect(() => normalizeLinearIssueWindow({ ...input, activity: [] })).toThrow(
      BrainSourceNormalizationError,
    );
    expect(() => normalizeLinearIssueWindow({ ...input, windowId: " " })).toThrow(/windowId/);
    expect(() => normalizeLinearIssueWindow({ ...input, flushedAt: "nope" })).toThrow(/timestamp/);
  });

  it("guards against other item shapes", () => {
    expect(isNormalizedLinearIssueSourceItem({ sourceProvider: "linear" })).toBe(false);
    expect(isNormalizedLinearIssueSourceItem(null)).toBe(false);
  });
});
