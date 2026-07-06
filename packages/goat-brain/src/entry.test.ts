import { describe, expect, it } from "vitest";
import {
  type GoatBrainEntry,
  goatBrainEntryFromLegacyMarkdown,
  goatBrainPayloadRelativePath,
  goatBrainSidecarRelativePath,
  parseGoatBrainSidecar,
  serializeGoatBrainPayload,
  serializeGoatBrainSidecar,
  serializeLegacyGoatBrainEntry,
  validateGoatBrainSidecar,
} from "./entry";

const entry: GoatBrainEntry = {
  id: "launch-plan",
  folder: "concepts",
  title: "Launch plan",
  kind: "markdown",
  mimeType: "text/markdown",
  body: "Launch should start with founder-led beta.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  relations: [{ type: "owner", to: "jane" }],
  sources: [{ ref: "meeting:launch", title: "Launch meeting" }],
  type: "concept",
  status: "draft",
  aliases: ["Founder beta"],
  tags: ["launch"],
  timeline: [
    {
      evidenceId: "ev-launch-meeting",
      at: "2026-01-02T00:00:00.000Z",
      body: "Discussed launch sequencing.",
    },
  ],
};

describe("goat brain canonical entries", () => {
  it("parses legacy embedded markdown into canonical body and timeline fields", () => {
    const legacy = serializeLegacyGoatBrainEntry(entry);
    const parsed = goatBrainEntryFromLegacyMarkdown(legacy);

    expect(parsed).toMatchObject({
      id: "launch-plan",
      folder: "concepts",
      title: "Launch plan",
      kind: "markdown",
      mimeType: "text/markdown",
      body: "Launch should start with founder-led beta.",
      relations: [{ type: "owner", to: "jane" }],
      sources: [{ ref: "meeting:launch", title: "Launch meeting" }],
      type: "concept",
      aliases: ["Founder beta"],
      tags: ["launch"],
      timeline: [
        {
          evidenceId: "ev-launch-meeting",
          at: "2026-01-02T00:00:00.000Z",
          body: "Discussed launch sequencing.",
        },
      ],
    });
  });

  it("serializes body-only payloads with hidden sidecar details", () => {
    const payload = serializeGoatBrainPayload(entry);
    const sidecar = parseGoatBrainSidecar(serializeGoatBrainSidecar(entry));

    expect(payload).toBe("Launch should start with founder-led beta.");
    expect(goatBrainPayloadRelativePath(entry.folder, entry.id)).toBe("concepts/launch-plan.md");
    expect(goatBrainSidecarRelativePath(entry.folder, entry.id)).toBe(
      "concepts/.brain/launch-plan.json",
    );
    expect(sidecar).toMatchObject({
      schemaVersion: "goat.brain.entry.v1",
      id: "launch-plan",
      folder: "concepts",
      type: "concept",
      aliases: ["Founder beta"],
      payload: {
        path: "concepts/launch-plan.md",
        sizeBytes: entry.body.length,
      },
    });
  });

  it("validates sidecar payload path, size, and hash", () => {
    const sidecar = parseGoatBrainSidecar(serializeGoatBrainSidecar(entry));
    const valid = validateGoatBrainSidecar({
      sidecar,
      payloadContent: entry.body,
      payloadRelativePath: "concepts/launch-plan.md",
    });

    expect(valid).toMatchObject({ ok: true, entry: { body: entry.body } });
    expect(
      validateGoatBrainSidecar({
        sidecar,
        payloadContent: `${entry.body}\nChanged.`,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateGoatBrainSidecar({
        sidecar,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/other.md",
      }),
    ).toMatchObject({ ok: false });
  });

  it("returns validation errors for malformed sidecar field types", () => {
    const sidecar = parseGoatBrainSidecar(serializeGoatBrainSidecar(entry));
    if (!sidecar) throw new Error("Expected serialized sidecar to parse.");
    expect(
      validateGoatBrainSidecar({
        sidecar: {
          ...sidecar,
          title: 42,
          mimeType: false,
          relations: "owner:jane",
        } as never,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        "sidecar.title must not be empty.",
        "sidecar.mimeType must not be empty.",
        "sidecar.relations must be an array.",
      ]),
    });
  });

  it("rejects malformed legacy markdown at the entry boundary", () => {
    expect(() => goatBrainEntryFromLegacyMarkdown("# Missing frontmatter")).toThrow(
      "Legacy brain document is missing a valid frontmatter.id.",
    );
  });
});
