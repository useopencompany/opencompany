import { describe, expect, it } from "vitest";
import { parseBrainDocument, serializeBrainDocument } from "./document";
import { brainWorkflowFromDocument, isBrainWorkflowFolder } from "./workflows";

function workflowDocument(
  overrides: {
    id?: string;
    folder?: string;
    description?: string;
    instructions?: string;
    status?: string;
    model?: string;
  } = {},
) {
  return parseBrainDocument(
    serializeBrainDocument({
      frontmatter: {
        id: overrides.id ?? "weekly-report",
        folder: overrides.folder ?? "workflows",
        kind: "page",
        type: "note",
        status: (overrides.status ?? "draft") as "draft",
        title: "Weekly report",
        ...(overrides.description === undefined
          ? { description: "Compiles the weekly report." }
          : overrides.description
            ? { description: overrides.description }
            : {}),
        ...(overrides.model ? { model: overrides.model } : {}),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        relations: [],
      },
      title: "Weekly report",
      compiledTruth:
        overrides.instructions ?? "Collect updates with @skill/research on @kimi-k2.6.",
      timeline: [],
    }),
  );
}

describe("opencompany Brain workflows", () => {
  it("recognizes the workflows folder and its subfolders", () => {
    expect(isBrainWorkflowFolder("workflows")).toBe(true);
    expect(isBrainWorkflowFolder("workflows/reporting")).toBe(true);
    expect(isBrainWorkflowFolder("skills")).toBe(false);
    expect(isBrainWorkflowFolder("workflows-archive")).toBe(false);
  });

  it("materializes a complete draft or active workflow page", () => {
    const workflow = brainWorkflowFromDocument(workflowDocument());
    expect(workflow).toEqual({
      id: "weekly-report",
      name: "Weekly report",
      description: "Compiles the weekly report.",
      instructions: "Collect updates with @skill/research on @kimi-k2.6.",
      model: "",
    });
    expect(brainWorkflowFromDocument(workflowDocument({ status: "active" }))).not.toBeNull();
  });

  it("round-trips the frontmatter model", () => {
    expect(brainWorkflowFromDocument(workflowDocument({ model: "codex" }))?.model).toBe("codex");
  });

  it("rejects documents outside the workflows folder", () => {
    expect(brainWorkflowFromDocument(workflowDocument({ folder: "skills" }))).toBeNull();
  });

  it("rejects archived documents and empty instructions", () => {
    expect(brainWorkflowFromDocument(workflowDocument({ status: "archived" }))).toBeNull();
    expect(brainWorkflowFromDocument(workflowDocument({ instructions: " " }))).toBeNull();
  });
});
