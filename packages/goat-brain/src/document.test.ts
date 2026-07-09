import { describe, expect, it } from "vitest";
import {
  parseGoatBrainDocument,
  replaceGoatBrainCompiledTruth,
  serializeGoatBrainDocument,
} from "./document";
import type { GoatBrainDocument } from "./schema";
import { goatBrainTimelineEntryFromParts } from "./timeline";
import { validateGoatBrainDocument } from "./validate";

describe("goat brain document", () => {
  it("round-trips frontmatter, compiled truth, and timeline", () => {
    const doc: GoatBrainDocument = {
      frontmatter: {
        id: "acme",
        folder: "companies",
        kind: "page",
        type: "company",
        status: "active",
        title: "Acme",
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

    const parsed = parseGoatBrainDocument(serializeGoatBrainDocument(doc));

    expect(parsed.frontmatter).toMatchObject(doc.frontmatter);
    expect(serializeGoatBrainDocument(doc)).toContain("related:");
    expect(serializeGoatBrainDocument(doc)).not.toContain("relations:");
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

    const updated = replaceGoatBrainCompiledTruth(source, "New truth.", {
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const parsed = parseGoatBrainDocument(updated);

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

  it("preserves timeline when adding a missing compiled truth section", () => {
    const source = `# Acme

## Timeline
### 2026-01-01T00:00:00.000Z
Original timeline body.
`;

    const updated = replaceGoatBrainCompiledTruth(source, "New truth.");
    const parsed = parseGoatBrainDocument(updated);

    expect(parsed.compiledTruth).toBe("New truth.");
    expect(parsed.timeline).toEqual([
      {
        evidenceId: expect.stringMatching(/^ev-20260101-original-timeline-body-[a-f0-9]{8}$/),
        at: "2026-01-01T00:00:00.000Z",
        body: "Original timeline body.",
      },
    ]);
  });

  it("rejects documents whose folder does not match the kind", () => {
    const pageInEvidenceZone = serializeGoatBrainDocument({
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
      validateGoatBrainDocument(
        parseGoatBrainDocument(pageInEvidenceZone),
        "acme",
        pageInEvidenceZone,
      ),
    ).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'frontmatter.folder/kind mismatch: folder "evidence/email" is inside the "evidence/" zone, which is reserved for evidence documents.',
      ]),
    });

    const evidenceOutsideZone = serializeGoatBrainDocument({
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
      validateGoatBrainDocument(
        parseGoatBrainDocument(evidenceOutsideZone),
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
      goatBrainTimelineEntryFromParts({
        at: "2026-01-01T00:00:00Z",
        summary: "Captured source information.",
      }),
    ).toMatchObject({ at: "2026-01-01T00:00:00.000Z" });
    expect(() =>
      goatBrainTimelineEntryFromParts({
        at: "not-a-date",
        summary: "Captured source information.",
      }),
    ).toThrow('Invalid timeline "at" value');
  });
});
