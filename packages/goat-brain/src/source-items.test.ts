import { describe, expect, it } from "vitest";
import {
  BrainSourceNormalizationError,
  githubActivityEventType,
  isNormalizedGitHubActivitySourceItem,
  isNormalizedGmailThreadSourceItem,
  isNormalizedGoatChatCaptureSourceItem,
  isNormalizedGoatImportSourceItem,
  isNormalizedGoogleDriveDocumentSourceItem,
  isNormalizedLinearIssueSourceItem,
  isNormalizedSlackConversationSourceItem,
  isNormalizedUploadAssetSourceItem,
  normalizeGitHubActivityWebhook,
  normalizeGmailThreadWindow,
  normalizeGoatChatCapture,
  normalizeGoatImportRun,
  normalizeGoogleDriveDocument,
  normalizeJamieMeetingCompletedWebhook,
  normalizeLinearIssueWindow,
  normalizeSlackConversationWindow,
  normalizeUploadAsset,
  slackTsToIso,
} from "./source-items";

describe("Goat company import normalization", () => {
  const base = {
    phase: "research" as const,
    importRunId: "gbimp_123",
    companyUrl: "https://acme.example",
    companyDomain: "acme.example",
    companyName: "Acme",
    searches: [{ query: "acme.example company", category: "company" as const }],
    results: [
      {
        title: "Acme",
        url: "https://acme.example/about",
        highlights: ["Acme builds rockets."],
      },
    ],
    capturedAt: "2026-07-13T08:05:00.000Z",
  };

  it("creates a stable research source item", () => {
    const first = normalizeGoatImportRun(base);
    const second = normalizeGoatImportRun({
      ...base,
      capturedAt: "2026-07-13T09:05:00.000Z",
    });

    expect(first).toMatchObject({
      sourceProvider: "goat-import",
      sourceType: "run",
      externalId: "gbimp_123:research",
      sourceRef: "goat-import:gbimp_123:research",
    });
    expect(first.contentHash).toBe(second.contentHash);
    expect(isNormalizedGoatImportSourceItem(first)).toBe(true);
  });

  it("hashes finalization separately and rejects unrelated payloads", () => {
    const finalizer = normalizeGoatImportRun({
      phase: "finalize",
      importRunId: base.importRunId,
      companyUrl: base.companyUrl,
      companyDomain: base.companyDomain,
      childSummary: [{ provider: "github", status: "succeeded", summary: "Updated Acme." }],
      capturedAt: base.capturedAt,
    });

    expect(finalizer.externalId).toBe("gbimp_123:finalize");
    expect(finalizer.contentHash).not.toBe(normalizeGoatImportRun(base).contentHash);
    expect(isNormalizedGoatImportSourceItem({ sourceProvider: "goat-import" })).toBe(false);
  });
});

describe("Google Drive document normalization", () => {
  const base = {
    fileId: "drive_file_123",
    name: "Launch plan",
    mimeType: "application/vnd.google-apps.document",
    webViewLink: "https://docs.google.com/document/d/drive_file_123/edit",
    modifiedTime: "2026-07-13T08:00:00.000Z",
    version: "42",
    extractedText: "The launch is approved for September.",
    contentSha256: "a".repeat(64),
    capturedAt: "2026-07-13T08:05:00.000Z",
  };

  it("uses the canonical Drive provenance and document contract", () => {
    const item = normalizeGoogleDriveDocument(base);
    expect(item.sourceRef).toBe("google-drive:file:drive_file_123");
    expect(item.sourceProvider).toBe("google_drive");
    expect(item.sourceType).toBe("document");
    expect(item.content.document.webViewLink).toBe(base.webViewLink);
    expect(isNormalizedGoogleDriveDocumentSourceItem(item)).toBe(true);
  });

  it("deduplicates metadata-only changes but hashes content changes", () => {
    const first = normalizeGoogleDriveDocument(base);
    const renamed = normalizeGoogleDriveDocument({
      ...base,
      name: "Renamed launch plan",
      version: "43",
      modifiedTime: "2026-07-13T09:00:00.000Z",
      capturedAt: "2026-07-13T09:01:00.000Z",
    });
    const changed = normalizeGoogleDriveDocument({
      ...base,
      contentSha256: "b".repeat(64),
      version: "44",
    });
    expect(renamed.contentHash).toBe(first.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("rejects invalid digests and guards unrelated payloads", () => {
    expect(() => normalizeGoogleDriveDocument({ ...base, contentSha256: "bad" })).toThrow(
      BrainSourceNormalizationError,
    );
    expect(isNormalizedGoogleDriveDocumentSourceItem({ sourceProvider: "google_drive" })).toBe(
      false,
    );
  });
});

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

function jamieDocumentedPayload(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      id: "delivery_123",
      event: "meeting.completed",
      created: "2026-01-01T11:05:00.000Z",
    },
    data: {
      title: "Product Review",
      startTime: "2026-01-01T10:00:00.000Z",
      endTime: "2026-01-01T11:00:00.000Z",
      user: {
        id: "user_123",
        email: "founder@example.com",
      },
      summary: {
        markdown: "We reviewed the new onboarding flow.",
      },
      transcript: [
        {
          speakerName: "Jamie",
          startTime: "00:00:01",
          text: "Let's review the onboarding flow.",
        },
      ],
      participants: [{ id: "person_1", name: "Jamie", email: "jamie@example.com" }, "Alex"],
      event: {
        id: "meeting_123",
        externalId: "calendar_event_123",
        title: "Product Review",
        scheduledTime: "2026-01-01T10:00:00.000Z",
        endTime: "2026-01-01T11:00:00.000Z",
      },
      tasks: [{ content: "Ship the prototype", assignee: "Jamie" }],
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

  it("normalizes Jamie's documented meeting.completed payload shape", () => {
    const item = normalizeJamieMeetingCompletedWebhook(jamieDocumentedPayload(), {
      capturedAt: "2026-01-01T11:06:00.000Z",
    });

    expect(item.externalId).toBe("calendar_event_123");
    expect(item.sourceRef).toBe("jamie:meeting:calendar_event_123");
    expect(item.title).toBe("Product Review");
    expect(item.occurredAt).toBe("2026-01-01T10:00:00.000Z");
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

  it("preserves an explicit MCP source ref for the shared capture pipeline", () => {
    const item = normalizeGoatChatCapture(captureInput({ sourceRef: "mcp:capture_123" }));

    expect(item.sourceRef).toBe("mcp:capture_123");
    expect(isNormalizedGoatChatCaptureSourceItem(item)).toBe(true);
  });

  it.each([
    ["text", { text: "  " }],
    ["title", { title: "" }],
    ["chat session", { chatSessionId: " " }],
    ["message", { userMessageId: "" }],
    ["draft id", { draftBrainId: "" }],
    ["timestamp", { capturedAt: "not-a-date" }],
    ["source ref", { sourceRef: "not a source ref" }],
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

describe("Gmail thread window normalization", () => {
  const input = {
    windowId: "ggmwin_abc123",
    threadId: "thread_789",
    subject: "Series A term sheet",
    accountEmail: "founder@acme.com",
    messages: [
      {
        messageId: "msg_2",
        direction: "sent" as const,
        from: "Founder <founder@acme.com>",
        to: "Ada Investor <ada@fund.vc>",
        sentAt: "2026-07-13T10:05:00.000Z",
        bodyText: "Thanks, reviewing the terms now.",
      },
      {
        messageId: "msg_1",
        direction: "received" as const,
        from: "Ada Investor <ada@fund.vc>",
        to: "founder@acme.com, cofounder@acme.com",
        sentAt: "2026-07-13T10:00:00.000Z",
        bodyText: "Attached is the term sheet we discussed.",
        snippet: "Attached is the term sheet",
      },
    ],
    flushedAt: "2026-07-13T10:30:00.000Z",
  };

  it("normalizes a window and sorts messages by time", () => {
    const item = normalizeGmailThreadWindow(input);

    expect(item.sourceProvider).toBe("gmail");
    expect(item.sourceType).toBe("thread");
    expect(item.externalId).toBe("ggmwin_abc123");
    expect(item.sourceRef).toBe("gmail:thread:thread_789");
    expect(item.title).toBe("Series A term sheet");
    expect(item.content.thread.windowStart).toBe("2026-07-13T10:00:00.000Z");
    expect(item.content.thread.windowEnd).toBe("2026-07-13T10:05:00.000Z");
    expect(item.content.thread.messages.map((message) => message.messageId)).toEqual([
      "msg_1",
      "msg_2",
    ]);
    expect(item.content.thread.participants).toContain("Ada Investor <ada@fund.vc>");
    expect(item.content.thread.participants).toContain("cofounder@acme.com");
    expect(item.occurredAt).toBe("2026-07-13T10:00:00.000Z");
    expect(item.capturedAt).toBe("2026-07-13T10:30:00.000Z");
    expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(isNormalizedGmailThreadSourceItem(item)).toBe(true);
  });

  it("hashes message identity, not body enrichment", () => {
    const base = normalizeGmailThreadWindow(input);
    const enriched = normalizeGmailThreadWindow({
      ...input,
      messages: input.messages.map((message) => ({
        ...message,
        bodyText: `${message.bodyText} (edited)`,
      })),
    });
    expect(enriched.contentHash).toBe(base.contentHash);
    const differentWindow = normalizeGmailThreadWindow({
      ...input,
      messages: input.messages.slice(0, 1),
    });
    expect(differentWindow.contentHash).not.toBe(base.contentHash);
  });

  it("falls back to a placeholder subject and flags stale snapshots", () => {
    const item = normalizeGmailThreadWindow({
      ...input,
      subject: "  ",
      snapshotStale: true,
    });
    expect(item.title).toBe("(no subject)");
    expect(item.content.thread.snapshotStale).toBe(true);
    expect(isNormalizedGmailThreadSourceItem(item)).toBe(true);
  });

  it("rejects empty windows and malformed input", () => {
    expect(() => normalizeGmailThreadWindow({ ...input, messages: [] })).toThrow(
      BrainSourceNormalizationError,
    );
    expect(() => normalizeGmailThreadWindow({ ...input, windowId: " " })).toThrow(/windowId/);
    expect(() => normalizeGmailThreadWindow({ ...input, flushedAt: "nope" })).toThrow(/timestamp/);
  });

  it("guards against other item shapes", () => {
    expect(isNormalizedGmailThreadSourceItem({ sourceProvider: "gmail" })).toBe(false);
    expect(isNormalizedGmailThreadSourceItem(null)).toBe(false);
  });
});

describe("GitHub activity normalization", () => {
  const capturedAt = "2026-07-01T12:00:00.000Z";

  function pullRequestPayload(overrides: Record<string, unknown> = {}) {
    return {
      action: "closed",
      repository: { id: 4242, full_name: "acme/api", private: true },
      pull_request: {
        number: 123,
        merged: true,
        title: "Add usage-based billing",
        body: "Implements metered billing per workspace.",
        html_url: "https://github.com/acme/api/pull/123",
        user: { login: "ada" },
        merged_by: { login: "grace" },
        created_at: "2026-07-01T09:30:00Z",
        merged_at: "2026-07-01T11:58:00Z",
        base: { ref: "main" },
        head: { ref: "billing" },
        additions: 120,
        deletions: 12,
        changed_files: 9,
        commits: 4,
        labels: [{ name: "feature" }],
        ...overrides,
      },
      installation: { id: 777 },
    };
  }

  it("normalizes a merged pull request", () => {
    const item = normalizeGitHubActivityWebhook("pull_request", pullRequestPayload(), {
      capturedAt,
    });
    expect(item).not.toBeNull();
    expect(item?.sourceProvider).toBe("github");
    expect(item?.sourceType).toBe("activity");
    expect(item?.externalId).toBe("acme/api:pull:123");
    expect(item?.sourceRef).toBe("github:acme/api:pull:123");
    expect(item?.title).toBe("acme/api #123 merged: Add usage-based billing");
    expect(item?.occurredAt).toBe("2026-07-01T11:58:00Z");
    expect(item?.content.activity).toMatchObject({
      kind: "pull_request",
      repository: { id: "4242", fullName: "acme/api", private: true },
      state: "merged",
      author: "ada",
      mergedBy: "grace",
      baseRef: "main",
      headRef: "billing",
      additions: 120,
      labels: ["feature"],
      truncatedBody: false,
    });
    expect(item ? githubActivityEventType(item.content.activity) : null).toBe(
      "pull_request_merged",
    );
    expect(isNormalizedGitHubActivitySourceItem(item)).toBe(true);
  });

  it("normalizes an opened pull request", () => {
    const item = normalizeGitHubActivityWebhook(
      "pull_request",
      { ...pullRequestPayload({ merged: false, merged_at: null }), action: "opened" },
      { capturedAt },
    );
    expect(item?.sourceRef).toBe("github:acme/api:pull:123");
    expect(item?.title).toBe("acme/api #123 opened: Add usage-based billing");
    expect(item?.occurredAt).toBe("2026-07-01T09:30:00Z");
    expect(item?.content.activity).toMatchObject({ state: "opened", author: "ada" });
    expect(item?.content.activity.mergedBy).toBeUndefined();
    expect(item ? githubActivityEventType(item.content.activity) : null).toBe(
      "pull_request_opened",
    );
  });

  it("ignores non-merged pull request closes and unsupported actions", () => {
    expect(
      normalizeGitHubActivityWebhook("pull_request", pullRequestPayload({ merged: false }), {
        capturedAt,
      }),
    ).toBeNull();
    expect(
      normalizeGitHubActivityWebhook(
        "pull_request",
        { ...pullRequestPayload(), action: "reopened" },
        { capturedAt },
      ),
    ).toBeNull();
    expect(normalizeGitHubActivityWebhook("push", {}, { capturedAt })).toBeNull();
    expect(
      normalizeGitHubActivityWebhook("release", { action: "published" }, { capturedAt }),
    ).toBeNull();
  });

  it("normalizes an opened issue and skips other issue actions and PRs-as-issues", () => {
    const payload = {
      action: "opened",
      repository: { id: 4242, full_name: "acme/api", private: false },
      issue: {
        number: 45,
        title: "Billing webhook drops retries",
        body: "Stripe retries are acked before processing.",
        html_url: "https://github.com/acme/api/issues/45",
        user: { login: "ada" },
        created_at: "2026-07-01T10:00:00Z",
        labels: [{ name: "bug" }],
      },
    };
    const item = normalizeGitHubActivityWebhook("issues", payload, { capturedAt });
    expect(item?.sourceRef).toBe("github:acme/api:issue:45");
    expect(item?.occurredAt).toBe("2026-07-01T10:00:00Z");
    expect(item?.content.activity).toMatchObject({
      kind: "issue",
      state: "opened",
      labels: ["bug"],
    });
    expect(item ? githubActivityEventType(item.content.activity) : null).toBe("issue_opened");

    expect(
      normalizeGitHubActivityWebhook("issues", { ...payload, action: "closed" }, { capturedAt }),
    ).toBeNull();
    const asPullRequest = {
      ...payload,
      issue: { ...payload.issue, pull_request: { url: "https://api.github.com/..." } },
    };
    expect(normalizeGitHubActivityWebhook("issues", asPullRequest, { capturedAt })).toBeNull();
  });

  function issueCommentPayload(
    overrides: {
      pullRequest?: boolean;
      comment?: Record<string, unknown>;
      issue?: Record<string, unknown>;
    } = {},
  ) {
    return {
      action: "created",
      repository: { id: 4242, full_name: "acme/api", private: false },
      issue: {
        number: 45,
        title: "Billing webhook drops retries",
        html_url: "https://github.com/acme/api/issues/45",
        labels: [{ name: "bug" }],
        ...(overrides.pullRequest ? { pull_request: { url: "https://api.github.com/..." } } : {}),
        ...overrides.issue,
      },
      comment: {
        id: 987654321,
        body: "We decided to drop retries older than 24h and alert on the rest.",
        html_url: "https://github.com/acme/api/issues/45#issuecomment-987654321",
        user: { login: "grace" },
        created_at: "2026-07-02T08:15:00Z",
        ...overrides.comment,
      },
      installation: { id: 777 },
    };
  }

  it("normalizes a comment on an issue", () => {
    const item = normalizeGitHubActivityWebhook("issue_comment", issueCommentPayload(), {
      capturedAt,
    });
    expect(item?.externalId).toBe("acme/api:issue:45:comment:987654321");
    expect(item?.sourceRef).toBe("github:acme/api:issue:45:comment:987654321");
    expect(item?.occurredAt).toBe("2026-07-02T08:15:00Z");
    expect(item?.content.activity).toMatchObject({
      kind: "issue",
      state: "commented",
      author: "grace",
      number: 45,
      title: "Billing webhook drops retries",
      url: "https://github.com/acme/api/issues/45#issuecomment-987654321",
    });
    expect(item ? githubActivityEventType(item.content.activity) : null).toBe("issue_commented");
    expect(isNormalizedGitHubActivitySourceItem(item)).toBe(true);
  });

  it("normalizes a comment on a pull request via the issue_comment event", () => {
    const item = normalizeGitHubActivityWebhook(
      "issue_comment",
      issueCommentPayload({ pullRequest: true }),
      { capturedAt },
    );
    expect(item?.externalId).toBe("acme/api:pull:45:comment:987654321");
    expect(item?.content.activity).toMatchObject({ kind: "pull_request", state: "commented" });
    expect(item ? githubActivityEventType(item.content.activity) : null).toBe(
      "pull_request_commented",
    );
  });

  it("ignores edited and deleted comments", () => {
    expect(
      normalizeGitHubActivityWebhook(
        "issue_comment",
        { ...issueCommentPayload(), action: "edited" },
        { capturedAt },
      ),
    ).toBeNull();
    expect(
      normalizeGitHubActivityWebhook(
        "issue_comment",
        { ...issueCommentPayload(), action: "deleted" },
        { capturedAt },
      ),
    ).toBeNull();
  });

  it("keeps distinct comments on the same thread as separate items", () => {
    const first = normalizeGitHubActivityWebhook("issue_comment", issueCommentPayload(), {
      capturedAt,
    });
    const second = normalizeGitHubActivityWebhook(
      "issue_comment",
      issueCommentPayload({ comment: { id: 111222333 } }),
      { capturedAt },
    );
    expect(first?.externalId).not.toBe(second?.externalId);
    expect(first?.contentHash).not.toBe(second?.contentHash);
  });

  it("throws on comment payloads missing the comment id", () => {
    expect(() =>
      normalizeGitHubActivityWebhook(
        "issue_comment",
        {
          action: "created",
          repository: { id: 1, full_name: "acme/api" },
          issue: { number: 1, title: "x", html_url: "https://x" },
          comment: { body: "hi", html_url: "https://x", created_at: "2026-07-02T08:15:00Z" },
        },
        { capturedAt },
      ),
    ).toThrow(BrainSourceNormalizationError);
  });

  it("derives stable content hashes and truncates oversized bodies", () => {
    const first = normalizeGitHubActivityWebhook("pull_request", pullRequestPayload(), {
      capturedAt,
    });
    const second = normalizeGitHubActivityWebhook("pull_request", pullRequestPayload(), {
      capturedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(first?.contentHash).toBe(second?.contentHash);

    // The same PR opened and later merged are distinct source items: same
    // external id, different state in the content hash.
    const opened = normalizeGitHubActivityWebhook(
      "pull_request",
      { ...pullRequestPayload({ merged: false, merged_at: null }), action: "opened" },
      { capturedAt },
    );
    expect(opened?.externalId).toBe(first?.externalId);
    expect(opened?.contentHash).not.toBe(first?.contentHash);

    const edited = normalizeGitHubActivityWebhook(
      "pull_request",
      pullRequestPayload({ body: "Rewritten description." }),
      { capturedAt },
    );
    expect(edited?.contentHash).not.toBe(first?.contentHash);

    const oversized = normalizeGitHubActivityWebhook(
      "pull_request",
      pullRequestPayload({ body: "x".repeat(30_000) }),
      { capturedAt },
    );
    expect(oversized?.content.activity.truncatedBody).toBe(true);
    expect(Buffer.byteLength(oversized?.content.activity.body ?? "", "utf8")).toBeLessThanOrEqual(
      20_000,
    );
  });

  it("throws on malformed payloads for supported actions", () => {
    expect(() =>
      normalizeGitHubActivityWebhook(
        "pull_request",
        { action: "closed", pull_request: { merged: true, number: 1 } },
        { capturedAt },
      ),
    ).toThrow(BrainSourceNormalizationError);
    expect(() =>
      normalizeGitHubActivityWebhook(
        "issues",
        { action: "opened", repository: { id: 1, full_name: "acme/api" }, issue: { number: 1 } },
        { capturedAt },
      ),
    ).toThrow(BrainSourceNormalizationError);
  });

  it("guards against other item shapes", () => {
    expect(isNormalizedGitHubActivitySourceItem({ sourceProvider: "github" })).toBe(false);
    expect(isNormalizedGitHubActivitySourceItem(null)).toBe(false);
  });
});
