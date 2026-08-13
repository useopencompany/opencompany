import { describe, expect, it } from "vitest";
import {
  collectSlackMentionUserIds,
  mentionsOtherHuman,
  mentionsSlackUser,
  sanitizeSlackMentions,
  stripSlackBotMention,
  toSlackMrkdwn,
  truncateForSlack,
} from "./slack-bot-format";

describe("stripSlackBotMention", () => {
  it("strips a leading mention of the bot", () => {
    expect(stripSlackBotMention("<@U123ABC> what did we learn?", "U123ABC")).toBe(
      "what did we learn?",
    );
  });

  it("strips mentions with a label and mid-sentence mentions", () => {
    expect(
      stripSlackBotMention("hey <@U123ABC|opencompany>, summarize <@U123ABC> please", "U123ABC"),
    ).toBe("hey , summarize please");
  });

  it("only strips a leading mention when the bot id is unknown", () => {
    expect(stripSlackBotMention("<@U123ABC> question about <@U456DEF>", null)).toBe(
      "question about <@U456DEF>",
    );
  });

  it("returns empty for a bare mention", () => {
    expect(stripSlackBotMention("<@U123ABC>", "U123ABC")).toBe("");
    expect(stripSlackBotMention("  <@U123ABC>   ", "U123ABC")).toBe("");
  });

  it("does not strip mentions of other users", () => {
    expect(stripSlackBotMention("<@U123ABC> ask <@U999> about it", "U123ABC")).toBe(
      "ask <@U999> about it",
    );
  });
});

describe("toSlackMrkdwn", () => {
  it("converts double-asterisk bold to Slack bold", () => {
    expect(toSlackMrkdwn("this is **important** and **also this**")).toBe(
      "this is *important* and *also this*",
    );
  });

  it("converts markdown headings to bold lines", () => {
    expect(toSlackMrkdwn("## Summary\ntext\n### Details")).toBe("*Summary*\ntext\n*Details*");
  });

  it("converts markdown links to Slack links", () => {
    expect(toSlackMrkdwn("see [the docs](https://example.com/a?b=1) here")).toBe(
      "see <https://example.com/a?b=1|the docs> here",
    );
  });

  it("leaves slack mrkdwn untouched", () => {
    const text = "*bold* _italic_ `code`\n• bullet\n<https://example.com|docs>";
    expect(toSlackMrkdwn(text)).toBe(text);
  });
});

describe("truncateForSlack", () => {
  it("returns short text unchanged", () => {
    expect(truncateForSlack("hello", 100)).toBe("hello");
  });

  it("truncates long text with a marker within the limit", () => {
    const result = truncateForSlack("a".repeat(500), 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("mentionsOtherHuman", () => {
  it("is false without any mention", () => {
    expect(mentionsOtherHuman("just a follow-up question", "UBOT")).toBe(false);
  });

  it("is false when only the bot is mentioned", () => {
    expect(mentionsOtherHuman("<@UBOT> what about pricing?", "UBOT")).toBe(false);
  });

  it("is true when another user is mentioned", () => {
    expect(mentionsOtherHuman("<@UHUMAN> can you take this?", "UBOT")).toBe(true);
    expect(mentionsOtherHuman("<@UHUMAN|jane> thoughts?", "UBOT")).toBe(true);
  });

  it("treats every mention as other when the bot id is unknown", () => {
    expect(mentionsOtherHuman("<@UANY> hello", null)).toBe(true);
  });
});

describe("mentionsSlackUser", () => {
  it("matches plain and labeled mentions of the given user", () => {
    expect(mentionsSlackUser("hey <@UBOT> hello", "UBOT")).toBe(true);
    expect(mentionsSlackUser("hey <@UBOT|opencompany> hello", "UBOT")).toBe(true);
  });

  it("does not match other users or missing ids", () => {
    expect(mentionsSlackUser("hey <@UOTHER> hello", "UBOT")).toBe(false);
    expect(mentionsSlackUser("hey <@UBOT> hello", null)).toBe(false);
  });
});

describe("sanitizeSlackMentions", () => {
  it("preserves only user mentions already present in the conversation", () => {
    const allowed = collectSlackMentionUserIds([
      "[Jane (<@UASKER>)]: what changed?",
      "[<@UTEAMMATE>]: I can help",
    ]);
    expect(
      sanitizeSlackMentions(
        "Thanks <@UASKER>. Ask <@UTEAMMATE>, not <@UINVENTED> or <!channel>.",
        allowed,
      ),
    ).toBe("Thanks <@UASKER>. Ask <@UTEAMMATE>, not `@UINVENTED` or `@channel`.");
  });

  it("neutralizes here, everyone, and user-group broadcasts without changing links", () => {
    expect(
      sanitizeSlackMentions(
        "See <https://example.com|docs> <!here> <!everyone> <!subteam^S123|ops>",
        new Set(),
      ),
    ).toBe("See <https://example.com|docs> `@here` `@everyone` `@user-group`");
  });
});
