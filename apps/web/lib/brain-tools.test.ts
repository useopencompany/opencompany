import { describe, expect, it } from "vitest";
import {
  coerceDocumentIds,
  getDocumentToToolInput,
  getTimelineToToolInput,
  listDocumentsToToolInput,
  resolveBrainParam,
  searchBrainToToolInput,
} from "./brain-tools";

describe("resolveBrainParam", () => {
  it("prefers brain, falls back to brain_id, trims, and returns undefined when absent", () => {
    expect(resolveBrainParam({ brain: "general-abc" })).toBe("general-abc");
    expect(resolveBrainParam({ brain_id: "general-abc" })).toBe("general-abc");
    expect(resolveBrainParam({ brain: "general-abc", brain_id: "other" })).toBe("general-abc");
    expect(resolveBrainParam({ brain: "  general-abc  " })).toBe("general-abc");
    expect(resolveBrainParam({})).toBeUndefined();
    expect(resolveBrainParam({ brain: "   " })).toBeUndefined();
  });
});

describe("searchBrainToToolInput", () => {
  it("maps a query into the query command with json output, default limit, and no neighbors", () => {
    expect(searchBrainToToolInput({ query: "workos sponsorship" })).toEqual({
      command: "query",
      flags: {
        text: "workos sponsorship",
        kind: "page",
        limit: 10,
        includeNeighbors: false,
        json: true,
      },
    });
  });

  it("omits text for a recency-only browse and passes since", () => {
    expect(searchBrainToToolInput({ since: "7d" })).toEqual({
      command: "query",
      flags: { kind: "page", since: "7d", limit: 10, includeNeighbors: false, json: true },
    });
  });

  it("opts into neighbors and passes snippetChars when set", () => {
    expect(
      searchBrainToToolInput({ query: "pricing", includeNeighbors: true, snippetChars: 150 }),
    ).toEqual({
      command: "query",
      flags: {
        text: "pricing",
        kind: "page",
        limit: 10,
        includeNeighbors: true,
        snippetChars: 150,
        json: true,
      },
    });
  });

  it("passes snippetChars: 0 through (no snippet), not swallowed as falsy", () => {
    expect(searchBrainToToolInput({ query: "pricing", snippetChars: 0 }).flags).toMatchObject({
      snippetChars: 0,
    });
  });

  it("threads filters and boolean flags without emitting falsy ones", () => {
    expect(
      searchBrainToToolInput({
        query: "pricing",
        folder: "decisions",
        type: "decision",
        kind: "page",
        limit: 25,
        hops: 1,
        lexicalOnly: true,
        includeMerged: true,
        includeArchived: false,
      }),
    ).toEqual({
      command: "query",
      flags: {
        text: "pricing",
        folder: "decisions",
        type: "decision",
        kind: "page",
        hops: 1,
        limit: 25,
        includeNeighbors: false,
        lexicalOnly: true,
        includeMerged: true,
        json: true,
      },
    });
  });

  it("passes evidence opt-in and continuation offsets explicitly", () => {
    expect(
      searchBrainToToolInput({
        query: "raw pricing email",
        kind: "evidence",
        offset: 10,
      }),
    ).toEqual({
      command: "query",
      flags: {
        text: "raw pricing email",
        kind: "evidence",
        limit: 10,
        offset: 10,
        includeNeighbors: false,
        json: true,
      },
    });
  });
});

describe("coerceDocumentIds / getDocumentToToolInput", () => {
  it("accepts a scalar id", () => {
    expect(coerceDocumentIds({ ids: "youtube-series" })).toEqual(["youtube-series"]);
    expect(getDocumentToToolInput({ ids: "youtube-series" })).toEqual({
      command: "get",
      flags: { id: ["youtube-series"], json: true },
    });
  });

  it("accepts an array of ids", () => {
    expect(coerceDocumentIds({ ids: ["a", "b"] })).toEqual(["a", "b"]);
    expect(getDocumentToToolInput({ ids: ["a", "b"] })).toEqual({
      command: "get",
      flags: { id: ["a", "b"], json: true },
    });
  });

  it("tolerates the singular `id` alias and trims/drops blanks", () => {
    expect(coerceDocumentIds({ id: "ev-gmail-217917958f18da216c" })).toEqual([
      "ev-gmail-217917958f18da216c",
    ]);
    expect(coerceDocumentIds({ id: ["  a  ", "", "b"] })).toEqual(["a", "b"]);
    expect(coerceDocumentIds({})).toEqual([]);
  });

  it("splits a comma-joined id string an agent packed into one field", () => {
    expect(coerceDocumentIds({ ids: "a, b, c" })).toEqual(["a", "b", "c"]);
    expect(coerceDocumentIds({ id: "a,b" })).toEqual(["a", "b"]);
    // Commas inside array items split too, and blanks from trailing commas drop.
    expect(coerceDocumentIds({ ids: ["a, b", "c,"] })).toEqual(["a", "b", "c"]);
  });

  it("passes an explicit section through", () => {
    expect(getDocumentToToolInput({ ids: "a", section: "truth" })).toEqual({
      command: "get",
      flags: { id: ["a"], section: "truth", json: true },
    });
  });
});

describe("listDocumentsToToolInput", () => {
  it("maps inventory filters into the list command", () => {
    expect(listDocumentsToToolInput({ folder: "people", kind: "page", limit: 50 })).toEqual({
      command: "list",
      flags: { folder: "people", kind: "page", limit: 50, json: true },
    });
  });

  it("defaults to a bare list when no filters are given", () => {
    expect(listDocumentsToToolInput({})).toEqual({
      command: "list",
      flags: { json: true },
    });
  });
});

describe("getTimelineToToolInput", () => {
  it("maps an id into the timeline command", () => {
    expect(getTimelineToToolInput({ id: "workos-sponsorship" })).toEqual({
      command: "timeline",
      flags: { id: "workos-sponsorship", json: true },
    });
  });

  it("threads since and limit", () => {
    expect(getTimelineToToolInput({ id: "x", since: "2d", limit: 20 })).toEqual({
      command: "timeline",
      flags: { id: "x", since: "2d", limit: 20, json: true },
    });
  });
});
