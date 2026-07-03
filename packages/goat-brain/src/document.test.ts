import { describe, expect, it } from "vitest";
import { parseGoatBrainDocument, serializeGoatBrainDocument } from "./document";
import type { GoatBrainDocument } from "./schema";

describe("goat brain document", () => {
  it("round-trips frontmatter, compiled truth, and timeline", () => {
    const doc: GoatBrainDocument = {
      frontmatter: {
        id: "acme",
        folder: "companies",
        title: "Acme",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        related: [{ type: "employs", target: "jane-doe" }],
        tags: ["customer"],
        sources: [{ ref: "gmail://message/1", capturedAt: "2026-01-01T00:00:00.000Z" }],
      },
      title: "Acme",
      compiledTruth: "Acme is evaluating the product.",
      timeline: [{ at: "2026-01-01T00:00:00.000Z", body: "Initial note." }],
    };

    const parsed = parseGoatBrainDocument(serializeGoatBrainDocument(doc));

    expect(parsed.frontmatter).toMatchObject(doc.frontmatter);
    expect(parsed.title).toBe("Acme");
    expect(parsed.compiledTruth).toBe("Acme is evaluating the product.");
    expect(parsed.timeline).toEqual(doc.timeline);
  });
});
