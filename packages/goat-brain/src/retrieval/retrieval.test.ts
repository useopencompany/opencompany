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
      | "conversation"
      | "decision"
      | "research"
      | "document"
      | "concept"
      | "reference"
      | "daily"
      | "note";
    title: string;
    truth: string;
    relations: Array<{ type: string; to: string }>;
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
        status: "active",
        title: input.title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: input.relations,
      },
      title: input.title,
      compiledTruth: `${input.truth} [^ev:ev-seed]`,
      timeline: [{ evidenceId: "ev-seed", at: "2026-01-01T00:00:00.000Z", body: "Seed." }],
    }),
    "utf8",
  );
}
