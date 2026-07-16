import { describe, expect, it } from "vitest";
import {
  formatSlackThreadContext,
  formatSlackThreadContextPage,
  stripSlackBotMention,
  toSlackMrkdwn,
  truncateForSlack,
} from "./answer";

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

  it("leaves slack mrkdwn untouched", () => {
    const text = "*bold* _italic_ `code`\n• bullet";
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

describe("formatSlackThreadContext", () => {
  it("omits an oldest-first page when Slack reports newer replies", () => {
    expect(
      formatSlackThreadContextPage({
        messages: [{ user: "U1", text: "stale context" }],
        response_metadata: { next_cursor: "next-page" },
      }),
    ).toBeNull();
    expect(
      formatSlackThreadContextPage({
        messages: [{ user: "U1", text: "stale context" }],
        has_more: true,
      }),
    ).toBeNull();
  });

  it("keeps the most recent twenty messages in chronological order", () => {
    const context = formatSlackThreadContext(
      Array.from({ length: 25 }, (_, index) => ({ user: `U${index}`, text: `message ${index}` })),
    );

    expect(context).not.toContain("message 4");
    expect(context).toContain("U5: message 5");
    expect(context).toContain("U24: message 24");
    expect(context?.indexOf("message 5")).toBeLessThan(context?.indexOf("message 24") ?? 0);
  });

  it("caps individual messages and the total prompt context", () => {
    const context = formatSlackThreadContext(
      Array.from({ length: 20 }, (_, index) => ({
        user: `U${index}`,
        text: `${index}:${"x".repeat(5000)}`,
      })),
    );

    expect(context).not.toBeNull();
    expect(context?.length).toBeLessThanOrEqual(12_000);
    expect(context).toContain("U19:");
    expect(context).not.toContain("U0:");
  });
});
