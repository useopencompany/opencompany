import { describe, expect, it } from "vitest";
import {
  BrainSourceNormalizationError,
  isNormalizedAttioObjectSourceItem,
  isNormalizedBrainPointerSourceItem,
  isNormalizedChatCaptureSourceItem,
  isNormalizedGmailThreadSourceItem,
  isNormalizedGoogleDriveDocumentSourceItem,
  isNormalizedHubspotObjectSourceItem,
  isNormalizedImportSourceItem,
  isNormalizedLinearIssueSourceItem,
  isNormalizedUploadAssetSourceItem,
  normalizeAttioObjectWindow,
  normalizeBrainPointerCapture,
  normalizeChatCapture,
  normalizeGmailThreadWindow,
  normalizeGoogleDriveDocument,
  normalizeHubspotObjectWindow,
  normalizeImportRun,
  normalizeJamieMeetingCompletedWebhook,
  normalizeLinearIssueWindow,
  normalizeUploadAsset,
} from "./source-items";

describe("opencompany company import normalization", () => {
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
    const first = normalizeImportRun(base);
    const second = normalizeImportRun({
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
    expect(isNormalizedImportSourceItem(first)).toBe(true);
  });

  it("hashes finalization separately and rejects unrelated payloads", () => {
    const finalizer = normalizeImportRun({
      phase: "finalize",
      importRunId: base.importRunId,
      companyUrl: base.companyUrl,
      companyDomain: base.companyDomain,
      childSummary: [{ provider: "linear", status: "succeeded", summary: "Updated Acme." }],
      capturedAt: base.capturedAt,
    });

    expect(finalizer.externalId).toBe("gbimp_123:finalize");
    expect(finalizer.contentHash).not.toBe(normalizeImportRun(base).contentHash);
    expect(isNormalizedImportSourceItem({ sourceProvider: "goat-import" })).toBe(false);
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

describe("opencompany chat capture normalization", () => {
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
    const item = normalizeChatCapture(captureInput());

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
    expect(isNormalizedChatCaptureSourceItem(item)).toBe(true);
    expect(isNormalizedChatCaptureSourceItem(JSON.parse(JSON.stringify(item)))).toBe(true);
  });

  it("derives stable content hashes and changes them when the text changes", () => {
    const first = normalizeChatCapture(captureInput());
    const second = normalizeChatCapture(captureInput());
    const changed = normalizeChatCapture(captureInput({ text: "Different idea." }));

    expect(second.contentHash).toBe(first.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("accepts a stable external id for durable host-tool retries", () => {
    const item = normalizeChatCapture(
      captureInput({ externalId: "codex-save:stable-capture-key" }),
    );

    expect(item.externalId).toBe("codex-save:stable-capture-key");
    expect(isNormalizedChatCaptureSourceItem(item)).toBe(true);
  });

  it("omits an empty intent", () => {
    const item = normalizeChatCapture(captureInput({ intent: "  " }));
    expect(item.content.capture.intent).toBeUndefined();
  });

  it("preserves an explicit MCP source ref for the shared capture pipeline", () => {
    const item = normalizeChatCapture(captureInput({ sourceRef: "mcp:capture_123" }));

    expect(item.sourceRef).toBe("mcp:capture_123");
    expect(isNormalizedChatCaptureSourceItem(item)).toBe(true);
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
    expect(() => normalizeChatCapture(captureInput(override))).toThrow(
      BrainSourceNormalizationError,
    );
  });

  it("rejects non-capture payloads in the guard", () => {
    expect(isNormalizedChatCaptureSourceItem(null)).toBe(false);
    expect(isNormalizedChatCaptureSourceItem({ sourceProvider: "goat-chat" })).toBe(false);
    expect(
      isNormalizedChatCaptureSourceItem(normalizeJamieMeetingCompletedWebhook(jamiePayload())),
    ).toBe(false);
  });
});

describe("opencompany Brain pointer capture normalization", () => {
  const base = {
    sourceRef: "gmail:thread:thread_123",
    title: "Launch discussion email",
    chatSessionId: "goat_chat_session_1",
    userMessageId: "goat_chat_msg_1",
    draftBrainId: "launch-discussion-email",
    draftFolder: "inbox",
    capturedAt: "2026-07-09T10:00:00.000Z",
  };

  it("normalizes a hydratable source pointer", () => {
    const item = normalizeBrainPointerCapture({
      ...base,
      fallbackText: "A short fallback summary.",
    });

    expect(item).toMatchObject({
      sourceProvider: "gmail",
      sourceType: "pointer",
      externalId: base.sourceRef,
      sourceRef: base.sourceRef,
      title: "Launch discussion email",
    });
    expect(item.content.pointer).toMatchObject({
      ref: base.sourceRef,
      fallbackText: "A short fallback summary.",
      chatSessionId: "goat_chat_session_1",
      userMessageId: "goat_chat_msg_1",
      draftBrainId: "launch-discussion-email",
      draftFolder: "inbox",
    });
    expect(isNormalizedBrainPointerSourceItem(item)).toBe(true);
    expect(isNormalizedBrainPointerSourceItem(JSON.parse(JSON.stringify(item)))).toBe(true);
  });

  it("deduplicates by canonical source ref instead of chat metadata", () => {
    const first = normalizeBrainPointerCapture(base);
    const second = normalizeBrainPointerCapture({
      ...base,
      fallbackText: "Different fallback text.",
      chatSessionId: "another_session",
      userMessageId: "another_message",
      draftBrainId: "another-draft",
    });

    expect(second.contentHash).toBe(first.contentHash);
  });

  it("rejects unsupported pointer providers and unrelated guard payloads", () => {
    expect(() =>
      normalizeBrainPointerCapture({
        ...base,
        sourceRef: "github:issue:opencompany:123",
      }),
    ).toThrow(BrainSourceNormalizationError);
    expect(isNormalizedBrainPointerSourceItem(null)).toBe(false);
    expect(
      isNormalizedBrainPointerSourceItem(
        normalizeChatCapture({
          text: "A note",
          title: "Note",
          chatSessionId: "session",
          userMessageId: "message",
          draftBrainId: "note",
          draftFolder: "inbox",
          capturedAt: "2026-07-09T10:00:00.000Z",
        }),
      ),
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
    expect(item.content.asset.contentSha256).toBe("a".repeat(64));
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
    const legacy = normalizeUploadAsset(input);
    delete legacy.content.asset.contentSha256;
    expect(isNormalizedUploadAssetSourceItem(legacy)).toBe(true);
    expect(isNormalizedUploadAssetSourceItem({ sourceProvider: "upload" })).toBe(false);
    expect(isNormalizedUploadAssetSourceItem(null)).toBe(false);
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

describe("HubSpot object window normalization", () => {
  const input = {
    windowId: "ghubwin_abc123",
    portalId: "62515",
    objectType: "deal" as const,
    objectId: "9876",
    name: "Acme renewal",
    activity: [
      {
        occurredAt: "2026-07-16T10:00:00.000Z",
        action: "update" as const,
        propertyName: "dealstage",
        propertyValue: "closedwon",
      },
    ],
    flushedAt: "2026-07-16T10:30:00.000Z",
  };

  it("includes the portal id in stable provenance", () => {
    const item = normalizeHubspotObjectWindow(input);

    expect(item.sourceRef).toBe("hubspot:62515:deal:9876");
    expect(item.sourceProvider).toBe("hubspot");
    expect(isNormalizedHubspotObjectSourceItem(item)).toBe(true);
  });

  it("keeps equal object ids from different portals distinct", () => {
    const first = normalizeHubspotObjectWindow(input);
    const second = normalizeHubspotObjectWindow({ ...input, portalId: "99117" });

    expect(second.sourceRef).toBe("hubspot:99117:deal:9876");
    expect(second.sourceRef).not.toBe(first.sourceRef);
  });
});

describe("Attio object window normalization", () => {
  const input = {
    windowId: "gattwin_abc123",
    workspaceId: "14beef7a-99f7-4534-a87e-70b564330a4c",
    objectType: "deal" as const,
    recordId: "bf071e1f-6035-429d-b874-d83ea64ea13b",
    name: "Acme renewal",
    activity: [
      {
        occurredAt: "2026-07-16T10:00:00.000Z",
        action: "update" as const,
        attributeName: "Stage",
      },
      {
        occurredAt: "2026-07-16T09:00:00.000Z",
        action: "note" as const,
        noteTitle: "Kickoff call",
      },
    ],
    flushedAt: "2026-07-16T10:30:00.000Z",
    notes: [
      {
        noteId: "note_1",
        title: "Kickoff call",
        createdAt: "2026-07-16T09:00:00.000Z",
        content: "Agreed on pilot scope.",
      },
    ],
  };

  it("includes the workspace id in stable provenance", () => {
    const item = normalizeAttioObjectWindow(input);

    expect(item.sourceRef).toBe(
      "attio:14beef7a-99f7-4534-a87e-70b564330a4c:deal:bf071e1f-6035-429d-b874-d83ea64ea13b",
    );
    expect(item.sourceProvider).toBe("attio");
    expect(isNormalizedAttioObjectSourceItem(item)).toBe(true);
  });

  it("orders the window by occurrence and keeps note content", () => {
    const item = normalizeAttioObjectWindow(input);

    expect(item.content.object.windowStart).toBe("2026-07-16T09:00:00.000Z");
    expect(item.content.object.windowEnd).toBe("2026-07-16T10:00:00.000Z");
    expect(item.content.object.notes?.[0]?.content).toBe("Agreed on pilot scope.");
  });

  it("keeps equal record ids from different workspaces distinct", () => {
    const first = normalizeAttioObjectWindow(input);
    const second = normalizeAttioObjectWindow({ ...input, workspaceId: "other-workspace" });

    expect(second.sourceRef).not.toBe(first.sourceRef);
  });
});

describe("Gmail thread window normalization", () => {
  const input = {
    windowId: "ggmwin_abc123",
    threadId: "thread_789",
    subject: "Series A term sheet",
    accountEmail: "founder@acme.example",
    messages: [
      {
        messageId: "msg_2",
        direction: "sent" as const,
        from: "Founder <founder@acme.example>",
        to: "Ada Investor <ada@investor.example>",
        sentAt: "2026-07-13T10:05:00.000Z",
        bodyText: "Thanks, reviewing the terms now.",
      },
      {
        messageId: "msg_1",
        direction: "received" as const,
        from: "Ada Investor <ada@investor.example>",
        to: "founder@acme.example, cofounder@acme.example",
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
    expect(item.content.thread.participants).toContain("Ada Investor <ada@investor.example>");
    expect(item.content.thread.participants).toContain("cofounder@acme.example");
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
