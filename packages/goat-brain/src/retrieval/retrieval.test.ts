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
      title: "Acme",
      truth: "Acme is evaluating enterprise search.",
      related: [{ type: "employs", target: "jane-doe" }],
    });
    await writeDoc("people/jane-doe.md", {
      id: "jane-doe",
      folder: "people",
      title: "Jane Doe",
      truth: "Jane owns procurement.",
      related: [],
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
});

async function writeDoc(
  relativePath: string,
  input: {
    id: string;
    folder: string;
    title: string;
    truth: string;
    related: Array<{ type: string; target: string }>;
  },
) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(
    path.join(root, relativePath),
    serializeGoatBrainDocument({
      frontmatter: {
        id: input.id,
        folder: input.folder,
        title: input.title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        related: input.related,
      },
      title: input.title,
      compiledTruth: input.truth,
      timeline: [{ at: "2026-01-01T00:00:00.000Z", body: "Seed." }],
    }),
    "utf8",
  );
}
