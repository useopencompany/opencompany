import { describe, expect, it } from "vitest";
import { stripSlackBotMention, toSlackMrkdwn, truncateForSlack } from "./answer";

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
