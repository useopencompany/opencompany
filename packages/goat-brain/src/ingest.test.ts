import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeGoatBrainDocument } from "./document";
import { deriveGoatBrainEdges } from "./edges";
import { checkGoatBrainHealth } from "./health";
import { ingestGoatBrain } from "./ingest";
import { goatBrainKindForFolder } from "./schema";
import { defaultGoatBrainFolder, goatBrainFolderKindError } from "./schemas";
import { findGoatBrainFile } from "./store";
import { parseGoatBrainWikiLinks } from "./wiki-links";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-ingest-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goat brain entity types and wiki links", () => {
  it("suggests default folders per type and derives kind from folders", () => {
    expect(defaultGoatBrainFolder("person", "page")).toBe("people");
    expect(defaultGoatBrainFolder("company", "page")).toBe("companies");
    expect(defaultGoatBrainFolder("note", "page")).toBe("inbox");
    expect(defaultGoatBrainFolder("source", "page")).toBe("sources");
    expect(defaultGoatBrainFolder("email", "evidence")).toBe("evidence");
    expect(goatBrainKindForFolder("evidence")).toBe("evidence");
    expect(goatBrainKindForFolder("evidence/email")).toBe("evidence");
    expect(goatBrainKindForFolder("team/gtm")).toBe("page");
    expect(goatBrainFolderKindError("companies", "evidence")).toContain(
      'evidence documents must live under the "evidence/" zone.',
    );
    expect(goatBrainFolderKindError("evidence/email", "page")).toContain(
      "reserved for evidence documents",
    );
    expect(goatBrainFolderKindError("evidence/email", "evidence")).toBeNull();
    expect(goatBrainFolderKindError("team/gtm", "page")).toBeNull();
  });

  it("parses wiki links with optional labels", () => {
    expect(parseGoatBrainWikiLinks("Talk to [[page:jane-doe|Jane]] about [[acme]].")).toEqual([
      expect.objectContaining({ target: "jane-doe", label: "Jane", valid: true }),
      expect.objectContaining({ target: "acme", label: "acme", valid: true }),
    ]);
  });

  it("derives typed relation and wiki-link graph edges deterministically", () => {
    expect(
      deriveGoatBrainEdges({
        id: "acme",
        relations: [{ type: "employs", to: "jane-doe" }],
        body: "Talk to [[page:jane-doe|Jane]], [[roadmap]], and [[evidence:ev-seed]].",
      }),
    ).toEqual([
      { from: "acme", to: "ev-seed", type: "cites", sourceKind: "wiki_link" },
      { from: "acme", to: "jane-doe", type: "employs", sourceKind: "relation" },
      { from: "acme", to: "jane-doe", type: "wiki_link", sourceKind: "wiki_link" },
      { from: "acme", to: "roadmap", type: "wiki_link", sourceKind: "wiki_link" },
    ]);
  });
});

describe("goat brain ingest", () => {
  it("dry-runs a valid ingest plan without writing files", async () => {
    const gateway = fakeGateway(
      JSON.stringify({
        operations: [
          {
            action: "create",
            id: "acme",
            title: "Acme",
            type: "company",
            aliases: ["Acme Inc."],
            body: "Acme is evaluating Goat Brain.",
            timelineBody: "User mentioned Acme.",
            relations: [],
            tags: [],
          },
        ],
        schemaSuggestion: null,
      }),
    );

    const result = await ingestGoatBrain(
      root,
      { text: "Remember Acme is evaluating Goat Brain.", sourceRef: "goat-chat:1", dryRun: true },
      gateway,
    );

    expect(result).toMatchObject({
      dryRun: true,
      applied: [],
      plan: [expect.objectContaining({ id: "acme", type: "company" })],
    });
  });

  it("applies a repaired ingest plan and produces healthy sidecar-backed entries", async () => {
    const gateway = {
      chat: vi
        .fn()
        .mockResolvedValueOnce("not json")
        .mockResolvedValueOnce(
          JSON.stringify({
            operations: [
              {
                action: "create",
                id: "jane-doe",
                title: "Jane Doe",
                type: "person",
                aliases: ["Jane"],
                body: "Jane Doe is a founder.",
                timelineBody: "User asked Goat to remember Jane.",
                relations: [],
                tags: [],
              },
            ],
            schemaSuggestion: null,
          }),
        ),
    };

    const result = await ingestGoatBrain(
      root,
      { text: "Remember Jane Doe is a founder.", sourceRef: "goat-chat:2" },
      gateway,
    );

    expect(gateway.chat).toHaveBeenCalledTimes(2);
    expect(result.applied).toEqual([
      expect.objectContaining({ action: "create", id: "jane-doe", type: "person" }),
    ]);
    await expect(checkGoatBrainHealth(root)).resolves.toMatchObject({ errors: 0 });
  });

  it("uses normalized ids when deciding whether a plan updates an existing entry", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is an existing customer.",
    });
    const gateway = fakeGateway(
      JSON.stringify({
        operations: [
          {
            action: "update",
            id: "Acme",
            title: "Acme",
            type: "company",
            aliases: [],
            body: "Acme is evaluating Goat Brain.",
            timelineBody: "User mentioned Acme.",
            relations: [],
            tags: [],
          },
        ],
      }),
    );

    const result = await ingestGoatBrain(
      root,
      { text: "Remember Acme is evaluating Goat Brain.", sourceRef: "goat-chat:3", dryRun: true },
      gateway,
    );

    expect(result.plan).toEqual([expect.objectContaining({ action: "update", id: "acme" })]);
  });

  it("does not append duplicate timeline evidence for the same source and timestamp", async () => {
    const response = JSON.stringify({
      operations: [
        {
          action: "create",
          id: "acme",
          title: "Acme",
          type: "company",
          aliases: [],
          body: "Acme is evaluating Goat Brain.",
          timelineBody: "User mentioned Acme.",
          relations: [],
          tags: [],
        },
      ],
    });
    const options = {
      text: "Remember Acme is evaluating Goat Brain.",
      sourceRef: "goat-chat:4",
      at: "2026-07-06T12:00:00.000Z",
    };

    await ingestGoatBrain(root, options, fakeGateway(response));
    await ingestGoatBrain(root, options, fakeGateway(response));

    const file = await findGoatBrainFile(root, "acme");
    expect(file?.source.match(/^### ev-/gm)).toHaveLength(1);
  });

  it("returns partial ingest failures after preserving earlier successful writes", async () => {
    await mkdir(path.join(root, "people"), { recursive: true });
    await writeFile(path.join(root, "people/bad-entry.md"), "# Missing frontmatter", "utf8");
    const gateway = fakeGateway(
      JSON.stringify({
        operations: [
          {
            action: "create",
            id: "acme",
            title: "Acme",
            type: "company",
            aliases: [],
            body: "Acme is evaluating Goat Brain.",
            timelineBody: "User mentioned Acme.",
            relations: [],
            tags: [],
          },
          {
            action: "create",
            id: "bad-entry",
            title: "Bad Entry",
            type: "person",
            aliases: [],
            body: "This should fail when the existing malformed file is loaded.",
            timelineBody: "User mentioned a bad entry.",
            relations: [],
            tags: [],
          },
        ],
      }),
    );

    const result = await ingestGoatBrain(
      root,
      { text: "Remember Acme and Bad Entry.", sourceRef: "goat-chat:5" },
      gateway,
    );

    expect(result.applied).toEqual([expect.objectContaining({ id: "acme" })]);
    expect(result.failed).toEqual([
      expect.objectContaining({
        id: "bad-entry",
        error: "Brain document is missing a valid frontmatter.id.",
      }),
    ]);
    await expect(findGoatBrainFile(root, "acme")).resolves.toMatchObject({
      relativePath: "companies/acme.md",
    });
  });

  it("reports broken wiki links in doctor findings unless marked unresolved", async () => {
    await writeDoc("projects/roadmap.md", {
      id: "roadmap",
      folder: "projects",
      type: "project",
      title: "Roadmap",
      truth: "Depends on [[missing-project]].",
    });

    await expect(checkGoatBrainHealth(root)).resolves.toMatchObject({
      errors: 1,
      findings: [expect.objectContaining({ code: "broken_wiki_link" })],
    });
  });
});

function fakeGateway(response: string) {
  return { chat: vi.fn(async () => response) };
}

async function writeDoc(
  relativePath: string,
  input: {
    id: string;
    folder: string;
    type: "person" | "company" | "project" | "concept" | "note" | "analysis" | "source" | "email";
    title: string;
    truth: string;
  },
) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(
    path.join(root, relativePath),
    serializeGoatBrainDocument({
      frontmatter: {
        id: input.id,
        folder: input.folder,
        kind: goatBrainKindForFolder(input.folder),
        type: input.type,
        status: "active",
        title: input.title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: input.title,
      compiledTruth: `${input.truth} [^ev:ev-seed]`,
      timeline: [{ evidenceId: "ev-seed", at: "2026-01-01T00:00:00.000Z", body: "Seed." }],
    }),
    "utf8",
  );
}
