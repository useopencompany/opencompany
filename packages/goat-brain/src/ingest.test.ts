import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeGoatBrainDocument } from "./document";
import { checkGoatBrainHealth } from "./health";
import { ingestGoatBrain } from "./ingest";
import { inferGoatBrainEntityTypeFromFolder } from "./schemas";
import { parseGoatBrainWikiLinks } from "./wiki-links";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-ingest-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goat brain entity types and wiki links", () => {
  it("infers built-in entity types from existing folders", () => {
    expect(inferGoatBrainEntityTypeFromFolder("people")).toBe("person");
    expect(inferGoatBrainEntityTypeFromFolder("companies")).toBe("company");
    expect(inferGoatBrainEntityTypeFromFolder("docs/api")).toBe("source");
    expect(inferGoatBrainEntityTypeFromFolder("ideas")).toBe("note");
  });

  it("parses wiki links with optional labels", () => {
    expect(parseGoatBrainWikiLinks("Talk to [[jane-doe|Jane]] about [[acme]].")).toEqual([
      expect.objectContaining({ target: "jane-doe", label: "Jane", valid: true }),
      expect.objectContaining({ target: "acme", label: "acme", valid: true }),
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
    type:
      | "person"
      | "company"
      | "project"
      | "meeting"
      | "decision"
      | "research"
      | "source"
      | "note";
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
        type: input.type,
        title: input.title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: input.title,
      compiledTruth: input.truth,
      timeline: [{ at: "2026-01-01T00:00:00.000Z", body: "Seed." }],
    }),
    "utf8",
  );
}
