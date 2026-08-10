import { describe, expect, it } from "vitest";
import { descriptionFromGoatAdHocTaskPrompt, hasGoatAdHocTaskToken } from "@/lib/ad-hoc-task";

describe("Goat ad-hoc task mention", () => {
  it("recognizes the reserved token at a word boundary", () => {
    expect(hasGoatAdHocTaskToken("#task research the market")).toBe(true);
    expect(hasGoatAdHocTaskToken("Please #TASK research the market")).toBe(true);
    expect(hasGoatAdHocTaskToken("#tasks research the market")).toBe(false);
    expect(hasGoatAdHocTaskToken("Link: https://example.com/#task")).toBe(false);
  });

  it("removes the directive from the runner prompt", () => {
    expect(descriptionFromGoatAdHocTaskPrompt("#task research the market")).toBe(
      "research the market",
    );
    expect(descriptionFromGoatAdHocTaskPrompt("Please #task research the market")).toBe(
      "Please research the market",
    );
  });
});
