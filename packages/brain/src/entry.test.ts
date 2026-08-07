import { describe, expect, it } from "vitest";
import {
  type BrainEntry,
  brainEntryFromLegacyMarkdown,
  brainPayloadRelativePath,
  brainSidecarRelativePath,
  parseBrainSidecar,
  serializeBrainPayload,
  serializeBrainSidecar,
  serializeLegacyBrainEntry,
  validateBrainSidecar,
} from "./entry";

const entry: BrainEntry = {
  id: "launch-plan",
  folder: "concepts",
  title: "Launch plan",
  description: "A reusable launch workflow.",
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
    const legacy = serializeLegacyBrainEntry(entry);
    const parsed = brainEntryFromLegacyMarkdown(legacy);

    expect(parsed).toMatchObject({
      id: "launch-plan",
      folder: "concepts",
      title: "Launch plan",
      description: "A reusable launch workflow.",
      format: "markdown",
      kind: "page",
      mimeType: "text/markdown",
      body: "Launch should start with founder-led beta.",
      relations: [{ type: "owner", to: "jane" }],
      sources: [{ ref: "meeting:launch", title: "Launch meeting" }],
      type: "concept",
      aliases: ["Founder beta"],
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
    const payload = serializeBrainPayload(entry);
    const sidecar = parseBrainSidecar(serializeBrainSidecar(entry));

    expect(payload).toBe("Launch should start with founder-led beta.");
    expect(brainPayloadRelativePath(entry.folder, entry.id)).toBe("concepts/launch-plan.md");
    expect(brainSidecarRelativePath(entry.folder, entry.id)).toBe(
      "concepts/.brain/launch-plan.json",
    );
    expect(sidecar).toMatchObject({
      schemaVersion: "goat.brain.entry.v2",
      id: "launch-plan",
      folder: "concepts",
      format: "markdown",
      kind: "page",
      type: "concept",
      description: "A reusable launch workflow.",
      aliases: ["Founder beta"],
      payload: {
        path: "concepts/launch-plan.md",
        sizeBytes: entry.body.length,
      },
    });
  });

  it("serializes nested legacy markdown payloads as body-only text", () => {
    const nested = serializeLegacyBrainEntry(entry);

    expect(serializeBrainPayload({ ...entry, body: nested })).toBe(entry.body);
  });

  it("validates sidecar payload path, size, and hash", () => {
    const sidecar = parseBrainSidecar(serializeBrainSidecar(entry));
    const valid = validateBrainSidecar({
      sidecar,
      payloadContent: entry.body,
      payloadRelativePath: "concepts/launch-plan.md",
    });

    expect(valid).toMatchObject({ ok: true, entry: { body: entry.body } });
    expect(
      validateBrainSidecar({
        sidecar,
        payloadContent: `${entry.body}\nChanged.`,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateBrainSidecar({
        sidecar,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/other.md",
      }),
    ).toMatchObject({ ok: false });
  });

  it("returns validation errors for malformed sidecar field types", () => {
    const sidecar = parseBrainSidecar(serializeBrainSidecar(entry));
    if (!sidecar) throw new Error("Expected serialized sidecar to parse.");
    expect(
      validateBrainSidecar({
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
    const sidecar = parseBrainSidecar(serializeBrainSidecar(entry));
    if (!sidecar) throw new Error("Expected serialized sidecar to parse.");

    expect(() =>
      validateBrainSidecar({
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
      validateBrainSidecar({
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
    const sidecar = parseBrainSidecar(serializeBrainSidecar(entry));
    if (!sidecar) throw new Error("Expected serialized sidecar to parse.");

    expect(
      validateBrainSidecar({
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
      validateBrainSidecar({
        sidecar: { ...sidecar, kind: "markdown" } as never,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['sidecar.kind must be "page" or "evidence".']),
    });
    expect(
      validateBrainSidecar({
        sidecar: { ...sidecar, format: "binary" } as never,
        payloadContent: entry.body,
        payloadRelativePath: "concepts/launch-plan.md",
      }),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["sidecar.format is invalid."]),
    });
  });

  it("rejects malformed legacy markdown at the entry boundary", () => {
    expect(() => brainEntryFromLegacyMarkdown("# Missing frontmatter")).toThrow(
      "Brain document is missing a valid frontmatter.id.",
    );
    expect(() =>
      brainEntryFromLegacyMarkdown(
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
      brainEntryFromLegacyMarkdown(
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
