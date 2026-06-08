import { describe, expect, it } from "vitest";
import { extractCitations, parseDocument, serializeDocument } from "./document";
import type { MemoryDocument } from "./schema";

const canonical: MemoryDocument = {
  frontmatter: {
    id: "acme",
    type: "company",
    status: "active",
    createdAt: "2026-05-12T09:00:00Z",
    updatedAt: "2026-06-06T14:32:00Z",
    related: [{ type: "employs", target: "jane-doe" }],
    aliases: ["Acme Inc"],
  },
  title: "Acme",
  compiledTruth: "Acme is a customer since 2026-05 [^ev:acme-kickoff-2026-05-12].",
  timeline: [
    { at: "2026-05-12T09:00:00Z", body: "Kickoff. See [^ev:acme-kickoff-2026-05-12]." },
    { at: "2026-06-06T14:32:00Z", body: "Call with Jane. See [^ev:acme-call-2026-06-06]." },
  ],
};

describe("document round-trip", () => {
  it("serializes and re-parses without loss", () => {
    const text = serializeDocument(canonical);
    const parsed = parseDocument(text);
    expect(parsed.frontmatter.id).toBe("acme");
    expect(parsed.frontmatter.type).toBe("company");
    expect(parsed.frontmatter.aliases).toEqual(["Acme Inc"]);
    expect(parsed.frontmatter.related).toEqual([{ type: "employs", target: "jane-doe" }]);
    expect(parsed.title).toBe("Acme");
    expect(parsed.compiledTruth).toContain("customer since 2026-05");
    expect(parsed.timeline).toHaveLength(2);
  });

  it("reads legacy bare-string related entries as untyped edges, alongside typed ones", () => {
    const text = [
      "---",
      "id: acme",
      "type: company",
      "status: active",
      "created_at: 2026-05-12T09:00:00Z",
      "updated_at: 2026-05-12T09:00:00Z",
      "related:",
      "  - jane-doe",
      "  - { type: depends_on, target: globex }",
      "---",
      "# Acme",
      "",
      "## Compiled truth",
      "x",
      "",
      "## Timeline",
    ].join("\n");
    const parsed = parseDocument(text);
    expect(parsed.frontmatter.related).toEqual([
      { type: "related", target: "jane-doe" },
      { type: "depends_on", target: "globex" },
    ]);
  });

  it("sorts the timeline newest-first on serialize", () => {
    const timeline = serializeDocument(canonical).slice(
      serializeDocument(canonical).indexOf("## Timeline"),
    );
    const firstIdx = timeline.indexOf("### 2026-06-06T14:32:00Z");
    const secondIdx = timeline.indexOf("### 2026-05-12T09:00:00Z");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("keeps the compiled truth above the timeline sentinel", () => {
    const text = serializeDocument(canonical);
    const truthIdx = text.indexOf("## Compiled truth");
    const sentinelIdx = text.indexOf("TIMELINE:BELOW");
    const timelineIdx = text.indexOf("## Timeline");
    expect(truthIdx).toBeLessThan(sentinelIdx);
    expect(sentinelIdx).toBeLessThan(timelineIdx);
  });
});

describe("extractCitations", () => {
  it("pulls unique evidence ids from footnote citations", () => {
    expect(extractCitations("a [^ev:foo-1] b [^ev:bar-2] c [^ev:foo-1]")).toEqual([
      "foo-1",
      "bar-2",
    ]);
  });

  it("returns empty when there are no citations", () => {
    expect(extractCitations("no citations here")).toEqual([]);
  });
});
