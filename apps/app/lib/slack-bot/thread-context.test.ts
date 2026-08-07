import { describe, expect, it } from "vitest";
import {
  buildSlackContextMessages,
  formatSpeaker,
  SLACK_CONTEXT_MESSAGE_LIMIT,
  SLACK_CONTEXT_TOTAL_MAX_CHARS,
} from "./thread-context";

const BOT = "UBOT";

describe("buildSlackContextMessages", () => {
  it("maps the bot's own messages to assistant turns and humans to prefixed user turns", () => {
    const messages = buildSlackContextMessages(
      [
        { user: "U1", text: "what did we learn this week?", ts: "1" },
        { user: BOT, text: "Three customer calls happened.", ts: "2" },
        { user: "U2", text: "and from churned accounts?", ts: "3" },
      ],
      { botUserId: BOT, displayNames: new Map([["U1", "Jane"]]) },
    );

    expect(messages).toEqual([
      { role: "user", content: "[Jane (<@U1>)]: what did we learn this week?" },
      { role: "assistant", content: "Three customer calls happened." },
      { role: "user", content: "[<@U2>]: and from churned accounts?" },
    ]);
  });

  it("excludes the triggering message, subtypes, other-bot noise prefixes, and empty texts", () => {
    const messages = buildSlackContextMessages(
      [
        { user: "U1", text: "keep me", ts: "1" },
        { user: "U1", text: "channel join", ts: "2", subtype: "channel_join" },
        { user: "U9", bot_id: "B42", text: "automated report", ts: "3" },
        { user: "U1", text: "   ", ts: "4" },
        { user: "U1", text: "the trigger", ts: "5" },
      ],
      { botUserId: BOT, excludeTs: "5" },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("keep me");
    expect(messages[0]?.content).toContain("[bot]: automated report");
  });

  it("strips bot mentions from human messages", () => {
    const messages = buildSlackContextMessages(
      [{ user: "U1", text: `<@${BOT}> what changed?`, ts: "1" }],
      { botUserId: BOT },
    );
    expect(messages[0]?.content).toBe("[<@U1>]: what changed?");
  });

  it("merges consecutive same-role messages", () => {
    const messages = buildSlackContextMessages(
      [
        { user: "U1", text: "first", ts: "1" },
        { user: "U2", text: "second", ts: "2" },
        { user: BOT, text: "answer", ts: "3" },
      ],
      { botUserId: BOT },
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("[<@U1>]: first\n[<@U2>]: second");
  });

  it("keeps only the most recent messages within count and char limits", () => {
    const many = Array.from({ length: SLACK_CONTEXT_MESSAGE_LIMIT + 10 }, (_, index) => ({
      user: index % 2 === 0 ? "U1" : BOT,
      text: `message ${index}`,
      ts: String(index),
    }));
    const messages = buildSlackContextMessages(many, { botUserId: BOT });
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).not.toContain("message 9 ");
    expect(joined).toContain(`message ${SLACK_CONTEXT_MESSAGE_LIMIT + 9}`);

    const huge = Array.from({ length: 30 }, (_, index) => ({
      user: "U1",
      text: `${index}:${"x".repeat(5000)}`,
      ts: String(index),
    }));
    const capped = buildSlackContextMessages(huge, { botUserId: BOT });
    const total = capped.reduce((sum, message) => sum + message.content.length, 0);
    expect(total).toBeLessThanOrEqual(SLACK_CONTEXT_TOTAL_MAX_CHARS + 100);
    const cappedJoined = capped.map((message) => message.content).join("\n");
    expect(cappedJoined).toContain("29:");
    expect(cappedJoined).not.toContain("0:xxxx");
  });
});

describe("formatSpeaker", () => {
  it("uses the display name when known and falls back to the raw mention", () => {
    expect(formatSpeaker("U1", new Map([["U1", "Jane"]]))).toBe("[Jane (<@U1>)]");
    expect(formatSpeaker("U2", new Map())).toBe("[<@U2>]");
    expect(formatSpeaker("U3")).toBe("[<@U3>]");
  });
});
