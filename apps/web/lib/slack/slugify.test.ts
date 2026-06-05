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

  it("caps length at 66 chars and never ends in a hyphen after truncation", () => {
    expect(workspaceChannelSlug("a".repeat(100)).length).toBe(66);
    // A separator landing exactly on the cut boundary must not leave a trailing hyphen.
    const sliced = workspaceChannelSlug(`${"a".repeat(65)} rest`);
    expect(sliced.endsWith("-")).toBe(false);
    expect(sliced).toBe("a".repeat(65));
  });

  it("returns empty string for non-latin-only input", () => {
    expect(workspaceChannelSlug("日本語")).toBe("");
  });
});

describe("channelName", () => {
  it("builds <slug>-x-opencompany and falls back to team for an empty slug", () => {
    expect(channelName("")).toBe("team-x-opencompany");
    expect(channelName("acme-corp")).toBe("acme-corp-x-opencompany");
  });

  it("stays within Slack's 80-char limit for a max-length slug", () => {
    const slug = workspaceChannelSlug("a".repeat(100)); // capped at 66
    expect(channelName(slug).length).toBeLessThanOrEqual(80);
  });
});
