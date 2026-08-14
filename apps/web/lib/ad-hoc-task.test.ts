import { describe, expect, it } from "vitest";
import { descriptionFromAdHocTaskPrompt, hasAdHocTaskToken } from "@/lib/ad-hoc-task";

describe("opencompany ad-hoc task mention", () => {
  it("recognizes the reserved token at a word boundary", () => {
    expect(hasAdHocTaskToken("#task research the market")).toBe(true);
    expect(hasAdHocTaskToken("Please #TASK research the market")).toBe(true);
    expect(hasAdHocTaskToken("#tasks research the market")).toBe(false);
    expect(hasAdHocTaskToken("Link: https://example.com/#task")).toBe(false);
  });

  it("removes the directive from the runner prompt", () => {
    expect(descriptionFromAdHocTaskPrompt("#task research the market")).toBe("research the market");
    expect(descriptionFromAdHocTaskPrompt("Please #task research the market")).toBe(
      "Please research the market",
    );
  });
});
