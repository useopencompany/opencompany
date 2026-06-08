import { describe, expect, it } from "vitest";
import type { ParsedDocument } from "./document";
import { validateDocument } from "./validate";

function parsed(overrides: Partial<ParsedDocument["frontmatter"]>): ParsedDocument {
  return {
    frontmatter: {
      id: "acme",
      type: "company",
      status: "active",
      freshness: "fresh",
      createdAt: "2026-05-12T09:00:00Z",
      updatedAt: "2026-05-12T09:00:00Z",
      related: [],
      ...overrides,
    },
    title: "Acme",
    compiledTruth: "truth",
    timeline: [],
  };
}

describe("validateDocument", () => {
  it("accepts a well-formed canonical object", () => {
    const result = validateDocument(parsed({}), "acme");
    expect(result.ok).toBe(true);
  });

  it("rejects id that does not match the file name", () => {
    const result = validateDocument(parsed({}), "other");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("must equal the file name");
  });

  it("rejects an invalid timestamp", () => {
    const result = validateDocument(parsed({ createdAt: "yesterday" }), "acme");
    expect(result.ok).toBe(false);
  });

  it("rejects canonical objects carrying evidence-only fields", () => {
    const result = validateDocument(parsed({ subjects: ["x"] }), "acme");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("only valid on evidence");
  });

  it("requires provenance and subjects on evidence", () => {
    const result = validateDocument(parsed({ id: "acme-call", type: "meeting" }), "acme-call");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join(" ");
      expect(joined).toContain("subjects");
      expect(joined).toContain("source");
    }
  });

  it("accepts well-formed evidence and matches source.kind to type", () => {
    const ok = validateDocument(
      parsed({
        id: "acme-call",
        type: "meeting",
        subjects: ["acme"],
        source: { kind: "meeting", ref: "gcal://x", capturedAt: "2026-06-06T14:30:00Z" },
      }),
      "acme-call",
    );
    expect(ok.ok).toBe(true);

    const mismatch = validateDocument(
      parsed({
        id: "acme-call",
        type: "meeting",
        subjects: ["acme"],
        source: { kind: "doc", ref: "gcal://x", capturedAt: "2026-06-06T14:30:00Z" },
      }),
      "acme-call",
    );
    expect(mismatch.ok).toBe(false);
  });

  it("requires merged_into when status is merged", () => {
    const result = validateDocument(parsed({ status: "merged" }), "acme");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("merged_into");
  });
});
