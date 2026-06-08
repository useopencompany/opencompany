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

  it("caps length at 59 chars and never ends in a hyphen after truncation", () => {
    expect(workspaceChannelSlug("a".repeat(100)).length).toBe(59);
    // A separator landing exactly on the cut boundary must not leave a trailing hyphen.
    const sliced = workspaceChannelSlug(`${"a".repeat(58)} rest`);
    expect(sliced.endsWith("-")).toBe(false);
    expect(sliced).toBe("a".repeat(58));
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

  it("inserts the per-workspace suffix: <slug>-<suffix>-x-opencompany", () => {
    expect(channelName("acme-corp", "a1b2c3")).toBe("acme-corp-a1b2c3-x-opencompany");
  });

  it("stays within Slack's 80-char limit with a max-length slug + suffix", () => {
    const slug = workspaceChannelSlug("a".repeat(100)); // capped at 59
    expect(channelName(slug, "abcdef").length).toBeLessThanOrEqual(80);
  });
});
