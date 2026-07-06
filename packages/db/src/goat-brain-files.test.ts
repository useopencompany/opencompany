import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGoatBrainMarkdownContent,
  deriveGoatBrainFileProjection,
  hashGoatBrainContent,
  materializeGoatBrainFilesToRoot,
  readGoatBrainFilesFromRoot,
  syncGoatBrainFilesForUser,
} from "./goat-brain-files";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goat brain file sync", () => {
  it("projects evidence kind from evidence subtype markdown", () => {
    const content = createGoatBrainMarkdownContent({
      id: "ev-acme-email",
      folderPath: "evidence/email",
      title: "Acme email",
      type: "evidence",
      evidenceKind: "email",
      status: "active",
      compiledTruth: "Acme asked for enterprise pricing.",
    });

    expect(
      deriveGoatBrainFileProjection({
        path: "evidence/email/ev-acme-email.md",
        content,
      }),
    ).toMatchObject({
      brainId: "ev-acme-email",
      folderPath: "evidence/email",
      entityType: "evidence",
      evidenceKind: "email",
    });
  });

  it("recovers sidecar-backed markdown when only the payload hash is stale", async () => {
    await writeSidecarBackedPayload({
      relativePath: "companies/acme.md",
      payload: "Acme now evaluates Goat Brain.",
      sidecar: {
        schemaVersion: "goat.brain.entry.v1",
        id: "acme",
        folder: "companies",
        title: "Acme",
        kind: "markdown",
        mimeType: "text/markdown",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
        sources: [],
        type: "company",
        status: "draft",
        tags: [],
        timeline: [],
        payload: {
          path: "companies/acme.md",
          sha256: "stale",
          sizeBytes: 1,
        },
      },
    });

    const files = await readGoatBrainFilesFromRoot(root);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "companies/acme.md" });
    expect(files[0]?.skip).toBeUndefined();
    expect(files[0]?.content).toContain("id: acme");
    expect(files[0]?.content).toContain("# Acme");
    expect(files[0]?.content).toContain("Acme now evaluates Goat Brain.");
  });

  it("skips unrecoverable sidecar-backed markdown instead of throwing", async () => {
    await writeSidecarBackedPayload({
      relativePath: "competitors/rivalco-competitor.md",
      payload: "",
      sidecar: {
        schemaVersion: "goat.brain.entry.v1",
        id: "rivalco-competitor",
        folder: "competitors",
        title: "",
        kind: "markdown",
        mimeType: "text/markdown",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
        sources: [],
        type: "company",
        status: "draft",
        tags: [],
        timeline: [],
        payload: {
          path: "competitors/rivalco-competitor.md",
          sha256: "stale",
          sizeBytes: 1,
        },
      },
    });

    await expect(readGoatBrainFilesFromRoot(root)).resolves.toEqual([
      { path: "competitors/rivalco-competitor.md", content: "", skip: true },
    ]);
  });

  it("does not validate unchanged invalid files during sync", async () => {
    const content = "---\n---\n";
    const contentHash = hashGoatBrainContent(content);
    const db = syncSelectOnlyDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainId: "rivalco-competitor",
        folderPath: "competitors",
        contentHash,
      },
    ]);

    await expect(
      syncGoatBrainFilesForUser({
        userWorkosId: "user_1",
        files: [{ path: "competitors/rivalco-competitor.md", content }],
        baseSnapshot: [
          {
            id: "doc_1",
            brainId: "rivalco-competitor",
            folderPath: "competitors",
            path: "competitors/rivalco-competitor.md",
            contentHash,
          },
        ],
        db,
      }),
    ).resolves.toEqual({ upserted: 0, deleted: 0, conflicts: [] });
  });

  it("materializes invalid stored markdown as a raw file that can be deleted", async () => {
    const content = "---\n---\n";
    const db = materializeSelectDb([
      {
        id: "doc_1",
        userWorkosId: "user_1",
        brainId: "rivalco-competitor",
        folderPath: "competitors",
        content,
        contentHash: hashGoatBrainContent(content),
      },
    ]);

    await expect(
      materializeGoatBrainFilesToRoot({ userWorkosId: "user_1", root, db }),
    ).resolves.toEqual([
      {
        id: "doc_1",
        brainId: "rivalco-competitor",
        path: "competitors/rivalco-competitor.md",
        folderPath: "competitors",
        contentHash: hashGoatBrainContent(content),
      },
    ]);
    await expect(readGoatBrainFilesFromRoot(root)).resolves.toEqual([
      { path: "competitors/rivalco-competitor.md", content },
    ]);
  });
});

async function writeSidecarBackedPayload(input: {
  relativePath: string;
  payload: string;
  sidecar: Record<string, unknown>;
}) {
  const target = path.join(root, input.relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.payload, "utf8");
  const id = path.basename(input.relativePath, ".md");
  const sidecarPath = path.join(root, path.dirname(input.relativePath), ".brain", `${id}.json`);
  await mkdir(path.dirname(sidecarPath), { recursive: true });
  await writeFile(sidecarPath, `${JSON.stringify(input.sidecar, null, 2)}\n`, "utf8");
}

function syncSelectOnlyDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as never;
}

function materializeSelectDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  } as never;
}
