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
  it("excludes skills by default and includes them for an explicit skills folder", async () => {
    await writeDoc("skills/coding-work.md", {
      id: "coding-work",
      folder: "skills",
      type: "note",
      title: "Coding work",
      truth: "Always run focused verification.",
      relations: [],
    });

    await expect(
      queryGoatBrain(root, { text: "focused verification", lexicalOnly: true }),
    ).resolves.toEqual([]);
    await expect(
      queryGoatBrain(root, {
        text: "focused verification",
        folder: "skills",
        lexicalOnly: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "coding-work", folder: "skills" })]);
  });

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

  it("returns curated pages by default and evidence only when explicitly requested", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [],
      timeline: [
        {
          evidenceId: "ev-acme-email",
          at: "2026-01-01T00:00:00.000Z",
          body: "Captured [[evidence:ev-acme-email|Acme email]].",
        },
      ],
    });
    await writeDoc("evidence/email/ev-acme-email.md", {
      id: "ev-acme-email",
      folder: "evidence/email",
      kind: "evidence",
      type: "source",
      title: "Acme email",
      truth: "Enterprise search raw source evidence.",
      relations: [{ type: "about", to: "acme" }],
    });

    await expect(
      queryGoatBrain(root, { text: "enterprise search", lexicalOnly: true }),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "ev-acme-email" })]),
    );

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        kind: "evidence",
        lexicalOnly: true,
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "ev-acme-email" })]));
  });

  it("supports stable offset pagination across equally ranked pages", async () => {
    for (let index = 1; index <= 12; index++) {
      const suffix = String(index).padStart(2, "0");
      await writeDoc(`projects/pagination-${suffix}.md`, {
        id: `pagination-${suffix}`,
        folder: "projects",
        type: "project",
        title: `Pagination ${suffix}`,
        truth: "Shared pagination target.",
        relations: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }

    const first = await queryGoatBrain(root, {
      text: "shared pagination target",
      limit: 10,
      lexicalOnly: true,
    });
    const second = await queryGoatBrain(root, {
      text: "shared pagination target",
      limit: 10,
      offset: 10,
      lexicalOnly: true,
    });

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((hit) => hit.id)).size).toBe(12);
  });

  it("hides conflict copies from query results unless explicitly included", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [],
    });
    await writeDoc("companies/acme-conflict-1a2b3c4d.md", {
      id: "acme-conflict-1a2b3c4d",
      folder: "companies",
      type: "company",
      title: "Acme conflict",
      truth: "Acme is evaluating enterprise search.",
      status: "draft",
      relations: [{ type: "conflicts_with", to: "acme" }],
    });

    const hits = await queryGoatBrain(root, { text: "enterprise search", lexicalOnly: true });
    expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ id: "acme" })]));
    expect(hits).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "acme-conflict-1a2b3c4d" })]),
    );

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        lexicalOnly: true,
        includeConflicts: true,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "acme-conflict-1a2b3c4d" })]),
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

  it("rejects invalid since filters", async () => {
    await writeDoc("companies/acme.md", {
      id: "acme",
      folder: "companies",
      type: "company",
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      relations: [],
    });

    await expect(
      queryGoatBrain(root, {
        text: "enterprise search",
        since: "not-a-date",
        lexicalOnly: true,
      }),
    ).rejects.toThrow('Invalid "since" value: not-a-date');
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

  it("uses the embedding provider for semantic ranking when available", async () => {
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
    type: "person" | "company" | "project" | "meeting" | "concept" | "source" | "analysis" | "note";
    kind?: "page" | "evidence";
    title: string;
    truth: string;
    relations: Array<{ type: string; to: string }>;
    status?: "active" | "draft" | "archived" | "merged";
    updatedAt?: string;
    timeline?: Array<{ evidenceId: string; at: string; body: string }>;
  },
) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(
    path.join(root, relativePath),
    serializeGoatBrainDocument({
      frontmatter: {
        id: input.id,
        folder: input.folder,
        kind: input.kind ?? "page",
        type: input.type,
        status: input.status ?? "active",
        title: input.title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
        relations: input.relations,
      },
      title: input.title,
      compiledTruth: `${input.truth} [^ev:ev-seed]`,
      timeline: input.timeline ?? [
        { evidenceId: "ev-seed", at: "2026-01-01T00:00:00.000Z", body: "Seed." },
      ],
    }),
    "utf8",
  );
}
