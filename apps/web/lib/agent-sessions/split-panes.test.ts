import { describe, expect, it } from "vitest";

import { MAX_PANES, parseSplitParam, serializeSplitParam } from "./split-panes";

const PRIMARY = "primary-id";

describe("parseSplitParam", () => {
  it("returns an empty list for blank/missing input", () => {
    expect(parseSplitParam(undefined, PRIMARY)).toEqual([]);
    expect(parseSplitParam(null, PRIMARY)).toEqual([]);
    expect(parseSplitParam("", PRIMARY)).toEqual([]);
    expect(parseSplitParam("   ,  , ", PRIMARY)).toEqual([]);
  });

  it("parses a comma-separated list in order, trimming whitespace", () => {
    expect(parseSplitParam(" a , b ,c", PRIMARY)).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates, keeping first occurrence", () => {
    expect(parseSplitParam("a,b,a,c,b", PRIMARY)).toEqual(["a", "b", "c"]);
  });

  it("drops the primary id so it never renders twice", () => {
    expect(parseSplitParam(`a,${PRIMARY},b`, PRIMARY)).toEqual(["a", "b"]);
  });

  it("caps total panes at MAX_PANES (primary + secondaries)", () => {
    const result = parseSplitParam("a,b,c,d,e,f", PRIMARY);
    expect(result).toEqual(["a", "b", "c"]);
    expect(result.length).toBe(MAX_PANES - 1);
  });

  it("accepts an already-split array value (Next.js repeated query param)", () => {
    expect(parseSplitParam(["a", "b"], PRIMARY)).toEqual(["a", "b"]);
  });
});

describe("serializeSplitParam", () => {
  it("joins ids with commas", () => {
    expect(serializeSplitParam(["a", "b"])).toBe("a,b");
  });

  it("returns null when there are no secondary panes", () => {
    expect(serializeSplitParam([])).toBeNull();
  });

  it("round-trips with parseSplitParam", () => {
    const ids = parseSplitParam("a,b,c", PRIMARY);
    const serialized = serializeSplitParam(ids);
    expect(serialized).not.toBeNull();
    expect(parseSplitParam(serialized, PRIMARY)).toEqual(ids);
  });
});
