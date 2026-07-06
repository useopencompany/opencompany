import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeGoatBrainDocument } from "../document";
import { queryGoatBrain } from "./index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goat brain retrieval", () => {
  it("queries lexically and expands one hop across related docs", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [{ type: "employs", to: "jane-doe" }],
    });
    await writeDoc("people/jane-doe.md", {
      id: "jane-doe",
      folder: "people",
      type: "person",
      title: "Jane Doe",
      truth: "Jane owns procurement.",
      relations: [],
    });

    await expect(
      queryGoatBrain(root, { text: "enterprise search procurement", hops: 1, lexicalOnly: true }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acme" }),
        expect.objectContaining({ id: "jane-doe" }),
      ]),
    );
  });

  it("can constrain graph expansion to outgoing edges", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [{ type: "employs", to: "jane-doe" }],
    });
    await writeDoc("people/jane-doe.md", {
      id: "jane-doe",
      folder: "people",
      type: "person",
      title: "Jane Doe",
      truth: "Jane owns procurement.",
      relations: [],
    });

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        hops: 1,
        graphDirection: "out",
        lexicalOnly: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acme" }),
        expect.objectContaining({ id: "jane-doe", matchedBy: "graph" }),
      ]),
    );

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        hops: 1,
        graphDirection: "in",
        lexicalOnly: true,
      }),
    ).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "jane-doe" })]));
  });

  it("filters by folder, updated time, and merged status", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeDoc("projects/roadmap.md", {
      id: "roadmap",
      folder: "projects",
      type: "project",
      title: "Roadmap",
      truth: "Roadmap covers enterprise search.",
      relations: [],
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await writeDoc("projects/legacy-roadmap.md", {
      id: "legacy-roadmap",
      folder: "projects",
      type: "project",
      title: "Legacy Roadmap",
      truth: "Legacy roadmap covers enterprise search.",
      relations: [],
      status: "merged",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        folder: "projects",
        since: "2026-01-15T00:00:00.000Z",
        lexicalOnly: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "roadmap" })]);

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        folder: "projects",
        includeMerged: true,
        lexicalOnly: true,
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "legacy-roadmap" })]));
  });

  it("does not fall back to the full corpus for non-empty no-match queries", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [],
    });

    await expect(
      queryGoatBrain(root, { text: "no lexical match anywhere", lexicalOnly: true }),
    ).resolves.toEqual([]);
  });

  it("uses vector and rerank providers when available", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme has operational context.",
      relations: [],
    });
    await writeDoc("companies/beta.md", {
      id: "beta",
      folder: "companies",
      type: "company",
      title: "Beta",
      truth: "Beta has operational context.",
      relations: [],
    });

    await expect(
      queryGoatBrain(
        root,
        { text: "semantic target" },
        {
          embedTexts: async (texts) =>
            texts.map((text) =>
              text.includes("Beta") || text === "semantic target" ? [1, 0] : [0, 1],
            ),
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: "beta" }),
      expect.objectContaining({ id: "acme" }),
    ]);

    await expect(
      queryGoatBrain(
        root,
        { text: "operational context" },
        {
          rerank: async () => ["beta", "acme"],
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: "beta" }),
      expect.objectContaining({ id: "acme" }),
    ]);
  });

  it("caches document embeddings by content hash across semantic queries", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme has operational context.",
      relations: [],
    });
    await writeDoc("companies/beta.md", {
      id: "beta",
      folder: "companies",
      type: "company",
      title: "Beta",
      truth: "Beta has operational context.",
      relations: [],
    });
    const calls: string[][] = [];
    const embedTexts = async (texts: string[]) => {
      calls.push(texts);
      return texts.map((text) =>
        text.includes("Beta") || text === "semantic target" ? [1, 0] : [0, 1],
      );
    };

    await queryGoatBrain(root, { text: "semantic target" }, { embedTexts });
    await queryGoatBrain(root, { text: "semantic target" }, { embedTexts });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["semantic target"]);
    expect(calls[1]).toHaveLength(2);
    expect(calls[2]).toEqual(["semantic target"]);
  });
});

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
      | "concept"
      | "evidence"
      | "note";
    title: string;
    truth: string;
    relations: Array<{ type: string; to: string }>;
    status?: "active" | "draft" | "archived" | "merged";
    updatedAt?: string;
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
        status: input.status ?? "active",
        title: input.title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
        relations: input.relations,
      },
      title: input.title,
      compiledTruth: `${input.truth} [^ev:ev-seed]`,
      timeline: [{ evidenceId: "ev-seed", at: "2026-01-01T00:00:00.000Z", body: "Seed." }],
    }),
    "utf8",
  );
}
