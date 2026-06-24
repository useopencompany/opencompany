import { describe, expect, it } from "vitest";
import { insertTranscriptDraft } from "./insert";

describe("insertTranscriptDraft", () => {
  it("inserts into an empty composer and places the caret after the transcript", () => {
    expect(
      insertTranscriptDraft({
        value: "",
        transcript: "Please review the launch plan.",
        selectionStart: 0,
        selectionEnd: 0,
      }),
    ).toEqual({
      value: "Please review the launch plan.",
      caret: "Please review the launch plan.".length,
    });
  });

  it("adds readable spacing when appending to existing text", () => {
    expect(
      insertTranscriptDraft({
        value: "Hey Leo",
        transcript: "can you summarize this?",
        selectionStart: 7,
        selectionEnd: 7,
      }),
    ).toEqual({
      value: "Hey Leo can you summarize this?",
      caret: "Hey Leo can you summarize this?".length,
    });
  });

  it("replaces the selected range without adding extra spacing inside the replacement", () => {
    expect(
      insertTranscriptDraft({
        value: "Please [draft this] today",
        transcript: "send this",
        selectionStart: 7,
        selectionEnd: 19,
      }),
    ).toEqual({
      value: "Please send this today",
      caret: "Please send this".length,
    });
  });
});
