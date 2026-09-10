import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerDraftKey, persistComposerDraft, readComposerDraft } from "./chat-composer-draft";

describe("tab composer drafts", () => {
  const key = composerDraftKey("user", "workspace", null);
  const draft = { input: "Draft\nwith whitespace  ", mentions: [] };
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("saves exact text and removes empty drafts", () => {
    persistComposerDraft(key, draft);
    expect(readComposerDraft(key)).toEqual(draft);
    persistComposerDraft(key, { input: "", mentions: [] });
    expect(values.has(key)).toBe(false);
  });

  it("does not read a draft from another tab's storage", () => {
    persistComposerDraft(key, draft);
    const firstTab = values;
    values = new Map();
    expect(readComposerDraft(key)).toBeNull();
    persistComposerDraft(key, { input: "Second tab", mentions: [] });
    values = firstTab;
    expect(readComposerDraft(key)).toEqual(draft);
  });

  it.each([
    "{",
    "null",
    '{"input":42,"mentions":[]}',
    '{"input":"Text","mentions":[{"kind":"engine","id":"invalid"}]}',
  ])("ignores invalid stored data: %s", (value) => {
    values.set(key, value);
    expect(readComposerDraft(key)).toBeNull();
  });

  it("keeps storage failures from breaking the composer", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("Storage blocked");
      },
    });
    expect(readComposerDraft(key)).toBeNull();
    expect(() => persistComposerDraft(key, draft)).not.toThrow();
    expect(() => persistComposerDraft(key, { input: "", mentions: [] })).not.toThrow();
  });
});
