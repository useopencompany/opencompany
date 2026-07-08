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
  format: "markdown",
  kind: "page",
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
      format: "markdown",
      kind: "page",
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
      schemaVersion: "goat.brain.entry.v2",
      id: "launch-plan",
      folder: "concepts",
      format: "markdown",
      kind: "page",
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

  it("rejects malformed evidence sidecar folders without throwing", () => {
    const sidecar = parseGoatBrainSidecar(serializeGoatBrainSidecar(entry));
    if (!sidecar) throw new Error("Expected serialized sidecar to parse.");

    expect(() =>
      validateGoatBrainSidecar({
        sidecar: {
          ...sidecar,
          kind: "evidence",
          folder: 42,
        } as never,
        payloadContent: entry.body,
        payloadRelativePath: "evidence/email/launch-plan.md",
      }),
    ).not.toThrow();
    expect(
      validateGoatBrainSidecar({
        sidecar: {
          ...sidecar,
          kind: "evidence",
          folder: 42,
        } as never,
        payloadContent: entry.body,
        payloadRelativePath: "evidence/email/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["sidecar.folder must be a safe lowercase folder path."]),
    });
  });

  it("rejects sidecar folder/kind mismatches and invalid kinds", () => {
    const sidecar = parseGoatBrainSidecar(serializeGoatBrainSidecar(entry));
    if (!sidecar) throw new Error("Expected serialized sidecar to parse.");

    expect(
      validateGoatBrainSidecar({
        sidecar: { ...sidecar, kind: "evidence" } as never,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'sidecar.folder/kind mismatch: evidence documents must live under the "evidence/" zone.',
      ]),
    });
    expect(
      validateGoatBrainSidecar({
        sidecar: { ...sidecar, kind: "markdown" } as never,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['sidecar.kind must be "page" or "evidence".']),
    });
    expect(
      validateGoatBrainSidecar({
        sidecar: { ...sidecar, format: "text" } as never,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["sidecar.format is invalid."]),
    });
  });

  it("rejects malformed legacy markdown at the entry boundary", () => {
    expect(() => goatBrainEntryFromLegacyMarkdown("# Missing frontmatter")).toThrow(
      "Brain document is missing a valid frontmatter.id.",
    );
    expect(() =>
      goatBrainEntryFromLegacyMarkdown(
        [
          "---",
          "id: launch-plan",
          "folder: concepts",
          "kind: page",
          "---",
          "",
          "# Launch plan",
          "",
          "## Compiled truth",
          "Body.",
          "",
          "## Timeline",
          "",
        ].join("\n"),
      ),
    ).toThrow("Brain document is missing a valid frontmatter.type.");
    expect(() =>
      goatBrainEntryFromLegacyMarkdown(
        [
          "---",
          "id: launch-plan",
          "folder: concepts",
          "type: concept",
          "---",
          "",
          "# Launch plan",
          "",
          "## Compiled truth",
          "Body.",
          "",
          "## Timeline",
          "",
        ].join("\n"),
      ),
    ).toThrow("Brain document is missing a valid frontmatter.kind.");
  });
});
