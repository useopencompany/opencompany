import { describe, expect, it } from "vitest";
import {
  appendBrainAssetTextBlock,
  extractBrainAssetText,
  normalizeBrainBody,
  normalizeBrainCompiledTruth,
  parseBrainDocument,
  replaceBrainCompiledTruth,
  serializeBrainDocument,
  stripBrainAssetTextBlock,
} from "./document";
import type { BrainDocument } from "./schema";
import { brainTimelineEntryFromParts } from "./timeline";
import { validateBrainDocument } from "./validate";

describe("goat brain document", () => {
  it("round-trips frontmatter, compiled truth, and timeline", () => {
    const doc: BrainDocument = {
      frontmatter: {
        id: "acme",
        folder: "companies",
        kind: "page",
        type: "company",
        status: "active",
        title: "Acme",
        description: "Company account context.",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        relations: [{ type: "employs", to: "jane-doe" }],
        sources: [{ ref: "gmail://message/1", capturedAt: "2026-01-01T00:00:00.000Z" }],
      },
      title: "Acme",
      compiledTruth: "Acme is evaluating the product.[^ev:ev-initial-note]",
      timeline: [
        {
          evidenceId: "ev-initial-note",
          at: "2026-01-01T00:00:00.000Z",
          body: "Initial note.",
        },
      ],
    };

    const parsed = parseBrainDocument(serializeBrainDocument(doc));

    expect(parsed.frontmatter).toMatchObject(doc.frontmatter);
    expect(serializeBrainDocument(doc)).toContain("related:");
    expect(serializeBrainDocument(doc)).not.toContain("relations:");
    expect(parsed.title).toBe("Acme");
    expect(parsed.compiledTruth).toBe("Acme is evaluating the product.[^ev:ev-initial-note]");
    expect(parsed.timeline).toEqual(doc.timeline);
  });

  it("reads legacy relations and preserves timeline when compiled truth changes", () => {
    const source = `---
id: acme
folder: companies
kind: page
type: company
status: active
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
relations:
  - type: employs
    to: jane-doe
---

# Acme

## Compiled truth
Old truth.

<!-- TIMELINE:BELOW - append only past this marker -->

## Timeline
### 2026-01-01T00:00:00.000Z
Original timeline body.
`;

    const updated = replaceBrainCompiledTruth(source, "New truth.", {
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const parsed = parseBrainDocument(updated);

    expect(parsed.frontmatter.relations).toEqual([{ type: "employs", to: "jane-doe" }]);
    expect(parsed.compiledTruth).toBe("New truth.");
    expect(parsed.timeline).toEqual([
      {
        evidenceId: expect.stringMatching(/^ev-20260101-original-timeline-body-[a-f0-9]{8}$/),
        at: "2026-01-01T00:00:00.000Z",
        body: "Original timeline body.",
      },
    ]);
  });

  it("preserves descriptions when replacing compiled truth", () => {
    const source = serializeBrainDocument({
      frontmatter: {
        id: "coding-work",
        folder: "skills",
        kind: "page",
        type: "note",
        status: "draft",
        title: "Coding work",
        description: "How coding work should happen.",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Coding work",
      compiledTruth: "Old instructions.",
      timeline: [],
    });

    const updated = parseBrainDocument(replaceBrainCompiledTruth(source, "New instructions."));
    expect(updated.frontmatter.description).toBe("How coding work should happen.");
    expect(updated.compiledTruth).toBe("New instructions.");
  });

  it("preserves timeline when adding a missing compiled truth section", () => {
    const source = `# Acme

## Timeline
### 2026-01-01T00:00:00.000Z
Original timeline body.
`;

    const updated = replaceBrainCompiledTruth(source, "New truth.");
    const parsed = parseBrainDocument(updated);

    expect(parsed.compiledTruth).toBe("New truth.");
    expect(parsed.timeline).toEqual([
      {
        evidenceId: expect.stringMatching(/^ev-20260101-original-timeline-body-[a-f0-9]{8}$/),
        at: "2026-01-01T00:00:00.000Z",
        body: "Original timeline body.",
      },
    ]);
  });

  it("unwraps a nested legacy brain document body to compiled truth", () => {
    const nested = serializeBrainDocument({
      frontmatter: {
        id: "nested-note",
        folder: "inbox",
        kind: "page",
        type: "note",
        status: "draft",
        title: "Nested note",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Nested note",
      compiledTruth: "Only this truth belongs in the editable body.",
      timeline: [
        {
          evidenceId: "ev-nested",
          at: "2026-01-01T00:00:00.000Z",
          body: "Nested timeline.",
        },
      ],
    });

    expect(normalizeBrainBody(nested)).toBe("Only this truth belongs in the editable body.");
  });

  it("removes a leading duplicate title heading from compiled truth", () => {
    expect(
      normalizeBrainCompiledTruth(
        "# Acme\n\nAcme evaluates the Brain.\n\n## Notes\nKeep this section.",
        "Acme",
      ),
    ).toBe("Acme evaluates the Brain.\n\n## Notes\nKeep this section.");
    expect(normalizeBrainCompiledTruth("## **Acme**\n\nAcme evaluates the Brain.", "Acme")).toBe(
      "Acme evaluates the Brain.",
    );
    expect(normalizeBrainCompiledTruth("# Acme overview\n\nBody.", "Acme")).toBe(
      "# Acme overview\n\nBody.",
    );
  });

  it("preserves ordinary markdown that starts with a frontmatter-like fence", () => {
    const markdown = `---
title: Example
---

This is a user-authored Markdown note, not a full Brain document.`;

    expect(normalizeBrainBody(markdown)).toBe(markdown);
  });

  it("does not nest frontmatter when replacing compiled truth with a legacy document", () => {
    const source = `---
id: acme
folder: companies
kind: page
type: company
status: draft
title: Acme
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
related: []
---

# Acme

## Compiled truth
Old truth.

<!-- TIMELINE:BELOW - append only past this marker -->

## Timeline
`;
    const nested = serializeBrainDocument({
      frontmatter: {
        id: "nested-note",
        folder: "inbox",
        kind: "page",
        type: "note",
        status: "draft",
        title: "Nested note",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Nested note",
      compiledTruth: "Replacement truth.",
      timeline: [],
    });

    const updated = replaceBrainCompiledTruth(source, nested);
    const parsed = parseBrainDocument(updated);

    expect(parsed.compiledTruth).toBe("Replacement truth.");
    expect(parsed.compiledTruth).not.toContain("---");
    expect(updated.match(/^---$/gm)).toHaveLength(2);
  });

  it("rejects documents whose folder does not match the kind", () => {
    const pageInEvidenceZone = serializeBrainDocument({
      frontmatter: {
        id: "acme",
        folder: "evidence/email",
        kind: "page",
        type: "company",
        status: "draft",
        title: "Acme",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Acme",
      compiledTruth: "Acme is a company.",
      timeline: [],
    });

    expect(
      validateBrainDocument(parseBrainDocument(pageInEvidenceZone), "acme", pageInEvidenceZone),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'frontmatter.folder/kind mismatch: folder "evidence/email" is inside the "evidence/" zone, which is reserved for evidence documents.',
      ]),
    });

    const evidenceOutsideZone = serializeBrainDocument({
      frontmatter: {
        id: "ev-acme-email",
        folder: "companies",
        kind: "evidence",
        type: "source",
        status: "draft",
        title: "Acme email",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Acme email",
      compiledTruth: "Acme asked for pricing.",
      timeline: [],
    });

    expect(
      validateBrainDocument(
        parseBrainDocument(evidenceOutsideZone),
        "ev-acme-email",
        evidenceOutsideZone,
      ),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'frontmatter.folder/kind mismatch: evidence documents must live under the "evidence/" zone.',
      ]),
    });
  });

  it("normalizes and validates generated timeline timestamps", () => {
    expect(
      brainTimelineEntryFromParts({
        at: "2026-01-01T00:00:00Z",
        summary: "Captured source information.",
      }),
    ).toMatchObject({ at: "2026-01-01T00:00:00.000Z" });
    expect(() =>
      brainTimelineEntryFromParts({
        at: "not-a-date",
        summary: "Captured source information.",
      }),
    ).toThrow('Invalid timeline "at" value');
  });

  it("validates inline links in timeline bodies", () => {
    const source = serializeBrainDocument({
      frontmatter: {
        id: "acme",
        folder: "companies",
        kind: "page",
        type: "company",
        status: "draft",
        title: "Acme",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Acme",
      compiledTruth: "Acme is a company.",
      timeline: [
        {
          evidenceId: "ev-invalid-source",
          at: "2026-01-01T00:00:00.000Z",
          body: "Captured from [[source:no-provider-id|an invalid source]].",
        },
      ],
    });

    expect(validateBrainDocument(parseBrainDocument(source), "acme", source)).toEqual({
      ok: false,
      errors: expect.arrayContaining(['source link target "no-provider-id" is invalid.']),
    });
  });
});

describe("goat brain asset text block", () => {
  const base = serializeBrainDocument({
    frontmatter: {
      id: "q3-board-deck",
      folder: "sources",
      kind: "page",
      type: "source",
      status: "draft",
      title: "Q3 Board Deck",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      relations: [],
    },
    title: "Q3 Board Deck",
    compiledTruth: "Uploaded file `deck.pdf`. Ingestion pending.",
    timeline: [],
  });

  it("appends, extracts, and strips the generated block", () => {
    const projected = appendBrainAssetTextBlock(base, "Revenue grew 40% QoQ.\n\nHiring plan.");
    expect(projected).toContain("## Extracted text");
    expect(extractBrainAssetText(projected)).toBe("Revenue grew 40% QoQ.\n\nHiring plan.");
    expect(stripBrainAssetTextBlock(projected)).toBe(base);
  });

  it("appends nothing for empty asset text", () => {
    expect(appendBrainAssetTextBlock(base, "   ")).toBe(base);
    expect(extractBrainAssetText(base)).toBe("");
    expect(stripBrainAssetTextBlock(base)).toBe(base);
  });

  it("parses documents ignoring the generated block, including edits inside it", () => {
    const projected = appendBrainAssetTextBlock(
      base,
      "### ev-fake - 2026-07-02T00:00:00.000Z\nlooks like a timeline entry",
    );
    const parsed = parseBrainDocument(projected);
    expect(parsed.compiledTruth).toBe("Uploaded file `deck.pdf`. Ingestion pending.");
    expect(parsed.timeline).toEqual([]);
    expect(parsed.frontmatter.id).toBe("q3-board-deck");
  });
});
