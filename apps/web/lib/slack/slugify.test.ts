import { describe, expect, it } from "vitest";
import { channelName, workspaceChannelSlug } from "./slugify";

describe("workspaceChannelSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(workspaceChannelSlug("Acme Corp")).toBe("acme-corp");
  });

  it("strips symbols and collapses repeats", () => {
    expect(workspaceChannelSlug("Foo & Bar!!  Baz")).toBe("foo-bar-baz");
  });

  it("strips diacritics", () => {
    expect(workspaceChannelSlug("Café Déjà")).toBe("cafe-deja");
  });

  it("trims leading/trailing hyphens", () => {
    expect(workspaceChannelSlug("  --hi--  ")).toBe("hi");
  });

  it("caps length at 72 chars", () => {
    expect(workspaceChannelSlug("a".repeat(100)).length).toBe(72);
  });

  it("returns empty string for non-latin-only input", () => {
    expect(workspaceChannelSlug("日本語")).toBe("");
  });
});

describe("channelName", () => {
  it("prefixes oc- and falls back to team for an empty slug", () => {
    expect(channelName("")).toBe("oc-team");
    expect(channelName("acme-corp")).toBe("oc-acme-corp");
  });

  it("appends a suffix when given", () => {
    expect(channelName("acme-corp", "a1b2c3")).toBe("oc-acme-corp-a1b2c3");
  });
});
