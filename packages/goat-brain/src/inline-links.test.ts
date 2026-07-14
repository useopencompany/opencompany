import { describe, expect, it } from "vitest";
import {
  evidenceLinkTargets,
  formatGoatBrainEvidenceLink,
  formatGoatBrainPageLink,
  formatGoatBrainSourceLink,
  pageLinkTargets,
  parseGoatBrainInlineLinks,
  sourceLinkTargets,
} from "./inline-links";

describe("goat brain inline links", () => {
  it("parses canonical page, evidence, and source links", () => {
    expect(
      parseGoatBrainInlineLinks(
        "See [[page:acme|Acme]], [[evidence:ev-acme-email|email]], and [[source:gmail:thread_1|thread]].",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "page",
        target: "acme",
        label: "Acme",
        valid: true,
        legacy: false,
      }),
      expect.objectContaining({
        kind: "evidence",
        target: "ev-acme-email",
        label: "email",
        valid: true,
        legacy: false,
      }),
      expect.objectContaining({
        kind: "source",
        target: "gmail:thread_1",
        label: "thread",
        valid: true,
        legacy: false,
      }),
    ]);
  });

  it("keeps legacy bare page links and evidence citations readable", () => {
    expect(parseGoatBrainInlineLinks("[[acme|Acme]] cites [^ev:ev-seed].")).toEqual([
      expect.objectContaining({
        kind: "page",
        target: "acme",
        label: "Acme",
        valid: true,
        legacy: true,
      }),
      expect.objectContaining({
        kind: "evidence",
        target: "ev-seed",
        label: "ev-seed",
        valid: true,
        legacy: true,
      }),
    ]);
  });

  it("reports invalid targets without dropping the link", () => {
    expect(
      parseGoatBrainInlineLinks("[[page:Bad Id]] [[evidence:not-ev]] [[source:bad]ref]]"),
    ).toEqual([
      expect.objectContaining({ kind: "page", target: "Bad Id", valid: false }),
      expect.objectContaining({ kind: "evidence", target: "not-ev", valid: false }),
    ]);
  });

  it("ignores escaped links and links inside Markdown code", () => {
    const text = [
      String.raw`\[[page:escaped|Escaped]]`,
      "`[[page:inline-code|Inline code]]`",
      "```text",
      "[[page:fenced-code|Fenced code]]",
      "```",
      "    [[page:indented-code|Indented code]]",
      "[[page:visible|Visible]]",
    ].join("\n");

    expect(parseGoatBrainInlineLinks(text)).toEqual([
      expect.objectContaining({ kind: "page", target: "visible", label: "Visible" }),
    ]);
    expect(parseGoatBrainInlineLinks(String.raw`\\[[page:visible|Visible]]`)).toEqual([
      expect.objectContaining({ kind: "page", target: "visible", label: "Visible" }),
    ]);
    expect(
      parseGoatBrainInlineLinks(
        "```text\r\n[[page:fenced-code|Fenced code]]\r\n```\r\n[[page:visible|Visible]]",
      ),
    ).toEqual([expect.objectContaining({ kind: "page", target: "visible", label: "Visible" })]);
  });

  it("requires source targets to be provider:id shaped", () => {
    expect(
      parseGoatBrainInlineLinks(
        "[[source:jamie:meeting:calendar_event_123]] [[source:noid]] [[source:Bad:ref]] [[source:gmail:thread 1]]",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "source",
        target: "jamie:meeting:calendar_event_123",
        valid: true,
      }),
      expect.objectContaining({ kind: "source", target: "noid", valid: false }),
      expect.objectContaining({ kind: "source", target: "Bad:ref", valid: false }),
      expect.objectContaining({ kind: "source", target: "gmail:thread 1", valid: false }),
    ]);
  });

  it("extracts valid targets by kind and dedupes by first occurrence", () => {
    const text =
      "[[page:acme]] [[page:acme|Acme]] [[evidence:ev-seed]] [^ev:ev-seed] [[source:gmail:1]]";

    expect(pageLinkTargets(text)).toEqual(["acme"]);
    expect(evidenceLinkTargets(text)).toEqual(["ev-seed"]);
    expect(sourceLinkTargets(text)).toEqual(["gmail:1"]);
  });

  it("formats canonical typed links", () => {
    expect(formatGoatBrainPageLink("acme", "Acme")).toBe("[[page:acme|Acme]]");
    expect(formatGoatBrainEvidenceLink("ev-seed")).toBe("[[evidence:ev-seed]]");
    expect(formatGoatBrainSourceLink("gmail:thread_1", "Thread")).toBe(
      "[[source:gmail:thread_1|Thread]]",
    );
  });

  it("rejects invalid formatted targets and labels", () => {
    expect(() => formatGoatBrainPageLink("Bad Id")).toThrow("Invalid Goat Brain page link target.");
    expect(() => formatGoatBrainEvidenceLink("seed")).toThrow(
      "Invalid Goat Brain evidence link target.",
    );
    expect(() => formatGoatBrainSourceLink("gmail:1", "bad]label")).toThrow(
      "Invalid Goat Brain link label.",
    );
    expect(() => formatGoatBrainPageLink("acme", "bad[label")).toThrow(
      "Invalid Goat Brain link label.",
    );
  });
});
