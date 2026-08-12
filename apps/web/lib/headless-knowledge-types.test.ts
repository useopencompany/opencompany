import type { BrainDocumentReadModel } from "@opencompany/protocol";
import { describe, expect, it } from "vitest";
import { brainDocumentToView } from "./headless-knowledge-types";

describe("headless knowledge presentation adapters", () => {
  it("derives a Brain document path from canonical identity after folder updates", () => {
    const document = brainDocumentToView({
      id: "document_1",
      brainId: "launch-plan",
      folderPath: "projects/active",
      path: "projects/old/launch-plan.md",
      title: "Launch plan",
      content: "",
      body: "",
      timeline: [],
      format: "markdown",
      mimeType: "text/markdown",
      originalFileName: null,
      assetSizeBytes: null,
      relations: [],
      sources: [],
      kind: "page",
      type: "project",
      status: "active",
      aliases: [],
      contentHash: "a".repeat(64),
      sizeBytes: 0,
      createdByActorId: "actor_1",
      createdAt: "2026-08-12T08:00:00.000Z",
      updatedAt: "2026-08-12T08:00:00.000Z",
    } satisfies BrainDocumentReadModel);

    expect(document.path).toBe("projects/active/launch-plan.md");
    expect(document.createdByWorkosId).toBe("actor_1");
    expect(document).not.toHaveProperty("createdByActorId");
  });
});
