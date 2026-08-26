import { normalizeGmailThreadWindow, normalizeSlackConversationWindow } from "@opencompany/brain";
import { describe, expect, it } from "vitest";
import { buildWikiIngestTriagePrompt } from "./wiki-ingest-triage";

describe("wiki source-only triage prompts", () => {
  it("builds Slack triage from source content without wiki state", () => {
    const item = normalizeSlackConversationWindow({
      windowId: "gslkwin_1",
      teamId: "T123",
      channelId: "C123",
      channelName: "product",
      channelType: "channel",
      messages: [
        {
          ts: "1724493600.000100",
          userId: "U123",
          userName: "Ada",
          text: "Acme approved the onboarding plan.",
        },
      ],
      flushedAt: "2026-08-24T10:00:00.000Z",
    });

    const prompt = buildWikiIngestTriagePrompt({
      sourceProvider: "slack",
      normalizedPayload: item,
      sourceConfig: {},
    });

    expect(prompt).toContain("Classify this Slack conversation window.");
    expect(prompt).toContain("Acme approved the onboarding plan.");
    expect(prompt).toContain("<untrusted-source-data>");
    expect(prompt).not.toContain("wiki tree");
  });

  it("places trusted Gmail source instructions before the untrusted thread payload", () => {
    const item = normalizeGmailThreadWindow({
      windowId: "ggmwin_1",
      threadId: "thread_1",
      subject: "Acme renewal",
      messages: [
        {
          messageId: "message_1",
          direction: "received",
          from: "customer@acme.example",
          to: "ada@example.com",
          sentAt: "2026-08-24T10:00:00.000Z",
          bodyText: "We approve the annual renewal.",
        },
      ],
      flushedAt: "2026-08-24T10:05:00.000Z",
    });

    const prompt = buildWikiIngestTriagePrompt({
      sourceProvider: "gmail",
      normalizedPayload: item,
      sourceConfig: { instructions: "Only capture customer commitments." },
    });

    expect(prompt).toContain("<trusted-owner-instructions>");
    expect(prompt).toContain("Only capture customer commitments.");
    expect(prompt).toContain("We approve the annual renewal.");
    expect(prompt!.indexOf("<trusted-owner-instructions>")).toBeLessThan(
      prompt!.indexOf("<untrusted-source-data>"),
    );
  });

  it("does not triage sources outside the Slack and Gmail gate", () => {
    expect(
      buildWikiIngestTriagePrompt({
        sourceProvider: "granola",
        normalizedPayload: {},
        sourceConfig: {},
      }),
    ).toBeNull();
  });
});
