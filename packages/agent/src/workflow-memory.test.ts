import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_WORKFLOW_MEMORY_TOOL_NAME,
  updateWorkflowMemory,
  WORKFLOW_MEMORY_MAX_CHARACTERS,
  workflowMemorySystemBlock,
} from "./workflow-memory";

describe("workflowMemorySystemBlock", () => {
  it("includes the stored memory and names the update tool", () => {
    const block = workflowMemorySystemBlock({
      enabled: true,
      content: "Pricing page changed on 2026-09-01.",
      updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(block).toContain("<workflow_memory>");
    expect(block).toContain("Pricing page changed on 2026-09-01.");
    expect(block).toContain("2026-09-01T10:00:00.000Z");
    expect(block).toContain(UPDATE_WORKFLOW_MEMORY_TOOL_NAME);
    expect(block.trimEnd().endsWith("</workflow_memory>")).toBe(true);
  });

  it("says so explicitly when nothing has been remembered yet", () => {
    const block = workflowMemorySystemBlock({ enabled: true, content: "  ", updatedAt: null });
    expect(block).toContain("has not written a memory yet");
    expect(block).not.toContain("last updated");
  });
});

describe("updateWorkflowMemory", () => {
  it("rejects content over the cap before touching the database", async () => {
    const db = { select: vi.fn(), update: vi.fn() };

    const result = await updateWorkflowMemory({
      workspaceId: "workspace_1",
      workflowSlug: "weekly-research",
      content: "x".repeat(WORKFLOW_MEMORY_MAX_CHARACTERS + 1),
      db: db as never,
    });

    expect(result).toEqual({
      ok: false,
      error: `Memory is limited to ${WORKFLOW_MEMORY_MAX_CHARACTERS} characters and this update is ${WORKFLOW_MEMORY_MAX_CHARACTERS + 1}. Summarize it and try again.`,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("refuses to write when the workflow has memory switched off", async () => {
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
        }),
      }),
      update: vi.fn(),
    };

    const result = await updateWorkflowMemory({
      workspaceId: "workspace_1",
      workflowSlug: "weekly-research",
      content: "Something worth keeping.",
      db: db as never,
    });

    expect(result).toEqual({ ok: false, error: "Memory is not enabled for this workflow." });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("stores trimmed content and reports its size", async () => {
    const set = vi.fn(() => ({ where: async () => undefined }));
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [{ workflowId: "workflow_1", enabled: true }],
            }),
          }),
        }),
      }),
      update: () => ({ set }),
    };
    const now = new Date("2026-09-15T12:00:00.000Z");

    const result = await updateWorkflowMemory({
      workspaceId: "workspace_1",
      workflowSlug: "weekly-research",
      content: "  Pricing changed.  ",
      db: db as never,
      now,
    });

    expect(result).toEqual({ ok: true, characters: "Pricing changed.".length });
    expect(set).toHaveBeenCalledWith({
      content: "Pricing changed.",
      contentUpdatedAt: now,
      updatedAt: now,
    });
  });
});
