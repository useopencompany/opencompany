import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentBrainByRef } from "@/lib/auth";
import {
  createBrainDocumentForUser,
  createBrainFolderForUser,
  deleteBrainDocumentForUser,
  updateBrainDocumentForUser,
} from "@/lib/brain";
import {
  createBrainDocumentAction,
  createBrainFolderAction,
  deleteBrainDocumentAction,
  updateBrainDocumentAction,
} from "@/lib/brain-actions";

vi.mock("@/lib/auth", () => ({
  currentBrainByRef: vi.fn(),
}));

vi.mock("@/lib/brain", () => ({
  createBrainDocumentForUser: vi.fn(),
  createBrainFolderForUser: vi.fn(),
  deleteBrainDocumentForUser: vi.fn(),
  deleteBrainFolderForUser: vi.fn(),
  moveBrainDocumentForUser: vi.fn(),
  renameBrainDocumentForUser: vi.fn(),
  renameBrainFolderForUser: vi.fn(),
  updateBrainDocumentForUser: vi.fn(),
}));

vi.mock("@/lib/brain-assets", () => ({
  createBrainAssetForUser: vi.fn(),
  replaceBrainAssetForUser: vi.fn(),
}));

describe("brain actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentBrainByRef).mockResolvedValue({
      context: { role: "admin", user: { workosUserId: "user_1" } },
      brain: { id: "goat_brain_team" },
    } as Awaited<ReturnType<typeof currentBrainByRef>>);
    vi.mocked(updateBrainDocumentForUser).mockResolvedValue({ ok: true });
    vi.mocked(deleteBrainDocumentForUser).mockResolvedValue({ ok: true });
    vi.mocked(createBrainDocumentForUser).mockResolvedValue({
      ok: true,
      path: "projects/roadmap.md",
    });
    vi.mocked(createBrainFolderForUser).mockResolvedValue({ ok: true, path: "projects" });
  });

  it("updates documents in the explicitly authorized brain", async () => {
    await updateBrainDocumentAction({
      brainRef: "goat_brain_requested",
      documentId: "doc_1",
      body: "Updated truth.",
      expectedContentHash: "hash_1",
    });

    expect(currentBrainByRef).toHaveBeenCalledWith("goat_brain_requested");
    expect(updateBrainDocumentForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      documentId: "doc_1",
      body: "Updated truth.",
      expectedContentHash: "hash_1",
    });
  });

  it("passes explicit brain authorization through destructive mutations", async () => {
    await deleteBrainDocumentAction({
      brainRef: "goat_brain_requested",
      documentId: "doc_1",
    });
    await createBrainFolderAction({
      brainRef: "goat_brain_requested",
      folderPath: "projects",
    });

    expect(deleteBrainDocumentForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      documentId: "doc_1",
    });
    expect(createBrainFolderForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      folderPath: "projects",
    });
  });

  it("creates manual Markdown files in the explicitly authorized brain", async () => {
    await createBrainDocumentAction({
      brainRef: "goat_brain_requested",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(createBrainDocumentForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });
  });

  it("rejects manual Markdown creation when the requested brain is inaccessible", async () => {
    vi.mocked(currentBrainByRef).mockRejectedValueOnce(
      new Error("You do not have access to that brain."),
    );

    const result = await createBrainDocumentAction({
      brainRef: "goat_brain_denied",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toEqual({ ok: false, message: "You do not have access to that brain." });
    expect(createBrainDocumentForUser).not.toHaveBeenCalled();
  });

  it("rejects manual Markdown creation for non-admin workspace members", async () => {
    vi.mocked(currentBrainByRef).mockResolvedValueOnce({
      context: { role: "member", user: { workosUserId: "user_1" } },
      brain: { id: "goat_brain_team" },
    } as Awaited<ReturnType<typeof currentBrainByRef>>);

    const result = await createBrainDocumentAction({
      brainRef: "goat_brain_team",
      folderPath: "projects",
      fileName: "Roadmap.md",
    });

    expect(result).toEqual({ ok: false, message: "Only workspace admins can edit the brain." });
    expect(createBrainDocumentForUser).not.toHaveBeenCalled();
  });

  it("returns a mutation error without writing when the requested brain is inaccessible", async () => {
    vi.mocked(currentBrainByRef).mockRejectedValueOnce(
      new Error("You do not have access to that brain."),
    );

    const result = await updateBrainDocumentAction({
      brainRef: "goat_brain_denied",
      documentId: "doc_1",
      body: "Updated truth.",
    });

    expect(result).toEqual({ ok: false, message: "You do not have access to that brain." });
    expect(updateBrainDocumentForUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin brain mutations without writing", async () => {
    vi.mocked(currentBrainByRef).mockResolvedValueOnce({
      context: { role: "member", user: { workosUserId: "user_1" } },
      brain: { id: "goat_brain_team" },
    } as Awaited<ReturnType<typeof currentBrainByRef>>);

    const result = await updateBrainDocumentAction({
      brainRef: "goat_brain_team",
      documentId: "doc_1",
      body: "Updated truth.",
    });

    expect(result).toEqual({ ok: false, message: "Only workspace admins can edit the brain." });
    expect(updateBrainDocumentForUser).not.toHaveBeenCalled();
  });
});
