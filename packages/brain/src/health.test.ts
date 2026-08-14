import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeBrainDocument } from "./document";
import { checkBrainHealth } from "./health";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "opencompany-brain-health-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkBrainHealth", () => {
  it("does not report weak provenance for first-class evidence records", async () => {
    await writeDoc(
      "evidence/email/ev-acme-email.md",
      serializeBrainDocument({
        title: "Acme email",
        compiledTruth: "Acme asked for enterprise pricing.",
        timeline: [],
        frontmatter: {
          id: "ev-acme-email",
          folder: "evidence/email",
          kind: "evidence",
          type: "source",
          status: "active",
          title: "Acme email",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          relations: [],
        },
      }),
    );

    const report = await checkBrainHealth(root);

    expect(report.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "weak_provenance" })]),
    );
  });

  it("warns on frontmatter source refs that are not provider:id shaped", async () => {
    await writeDoc(
      "people/ada.md",
      serializeBrainDocument({
        title: "Ada",
        compiledTruth: "",
        timeline: [],
        frontmatter: {
          id: "ada",
          folder: "people",
          kind: "page",
          type: "person",
          status: "active",
          title: "Ada",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          relations: [],
          sources: [{ ref: "manual" }, { ref: "jamie:meeting:calendar_event_123" }],
        },
      }),
    );

    const report = await checkBrainHealth(root);

    const refFindings = report.findings.filter(
      (finding) => finding.code === "nonstandard_source_ref",
    );
    expect(refFindings).toEqual([
      expect.objectContaining({
        severity: "warn",
        id: "ada",
        message: 'Source ref "manual" is not provider:id shaped.',
      }),
    ]);
  });
});

async function writeDoc(relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
