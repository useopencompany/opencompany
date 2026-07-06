import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeGoatBrainDocument } from "./document";
import { checkGoatBrainHealth } from "./health";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-health-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkGoatBrainHealth", () => {
  it("does not report weak provenance for first-class evidence records", async () => {
    await writeDoc(
      "evidence/email/ev-acme-email.md",
      serializeGoatBrainDocument({
        title: "Acme email",
        compiledTruth: "Acme asked for enterprise pricing.",
        timeline: [],
        frontmatter: {
          id: "ev-acme-email",
          folder: "evidence/email",
          type: "evidence",
          evidenceKind: "email",
          status: "active",
          title: "Acme email",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          relations: [],
        },
      }),
    );

    const report = await checkGoatBrainHealth(root);

    expect(report.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "weak_provenance" })]),
    );
  });
});

async function writeDoc(relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
