import { describe, expect, it } from "vitest";
import { hashWikiContent, lineDelta } from "./wiki";

describe("lineDelta", () => {
  it("counts added and removed lines as a multiset difference", () => {
    expect(lineDelta("a\nb\nc", "a\nb\nc\nd\ne")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("a\nb\nc", "a\nc")).toEqual({ added: 0, removed: 1 });
    expect(lineDelta("a\nb", "a\nB")).toEqual({ added: 1, removed: 1 });
  });

  it("handles duplicate lines and empty content", () => {
    expect(lineDelta("x\nx\nx", "x")).toEqual({ added: 0, removed: 2 });
    expect(lineDelta("", "one\ntwo")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("one\ntwo", "")).toEqual({ added: 0, removed: 2 });
    expect(lineDelta("", "")).toEqual({ added: 0, removed: 0 });
  });
});

describe("hashWikiContent", () => {
  it("is a stable sha256 hex digest", () => {
    expect(hashWikiContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
