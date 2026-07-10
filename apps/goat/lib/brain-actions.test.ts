import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatBrainByRef } from "@/lib/auth";
import {
  createGoatBrainFolderForUser,
  deleteGoatBrainDocumentForUser,
  updateGoatBrainDocumentForUser,
} from "@/lib/brain";
import {
  createGoatBrainFolderAction,
  deleteGoatBrainDocumentAction,
  updateGoatBrainDocumentAction,
} from "@/lib/brain-actions";

vi.mock("@/lib/auth", () => ({
  currentGoatBrainByRef: vi.fn(),
}));

vi.mock("@/lib/brain", () => ({
  createGoatBrainFolderForUser: vi.fn(),
  deleteGoatBrainDocumentForUser: vi.fn(),
  deleteGoatBrainFolderForUser: vi.fn(),
  moveGoatBrainDocumentForUser: vi.fn(),
  renameGoatBrainDocumentForUser: vi.fn(),
  renameGoatBrainFolderForUser: vi.fn(),
  updateGoatBrainDocumentForUser: vi.fn(),
}));

vi.mock("@/lib/brain-assets", () => ({
  createGoatBrainAssetForUser: vi.fn(),
  replaceGoatBrainAssetForUser: vi.fn(),
}));

describe("brain actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatBrainByRef).mockResolvedValue({
      context: { role: "admin", user: { workosUserId: "user_1" } },
      brain: { id: "goat_brain_team" },
    } as Awaited<ReturnType<typeof currentGoatBrainByRef>>);
    vi.mocked(updateGoatBrainDocumentForUser).mockResolvedValue({ ok: true });
    vi.mocked(deleteGoatBrainDocumentForUser).mockResolvedValue({ ok: true });
    vi.mocked(createGoatBrainFolderForUser).mockResolvedValue({ ok: true, path: "projects" });
  });

  it("updates documents in the explicitly authorized brain", async () => {
    await updateGoatBrainDocumentAction({
      brainRef: "goat_brain_requested",
      documentId: "doc_1",
      body: "Updated truth.",
      expectedContentHash: "hash_1",
    });

    expect(currentGoatBrainByRef).toHaveBeenCalledWith("goat_brain_requested");
    expect(updateGoatBrainDocumentForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      documentId: "doc_1",
      body: "Updated truth.",
      expectedContentHash: "hash_1",
    });
  });

  it("passes explicit brain authorization through destructive mutations", async () => {
    await deleteGoatBrainDocumentAction({
      brainRef: "goat_brain_requested",
      documentId: "doc_1",
    });
    await createGoatBrainFolderAction({
      brainRef: "goat_brain_requested",
      folderPath: "projects",
    });

    expect(deleteGoatBrainDocumentForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      documentId: "doc_1",
    });
    expect(createGoatBrainFolderForUser).toHaveBeenCalledWith({
      brainRef: "goat_brain_team",
      userWorkosId: "user_1",
      folderPath: "projects",
    });
  });

  it("returns a mutation error without writing when the requested brain is inaccessible", async () => {
    vi.mocked(currentGoatBrainByRef).mockRejectedValueOnce(
      new Error("You do not have access to that brain."),
    );

    const result = await updateGoatBrainDocumentAction({
      brainRef: "goat_brain_denied",
      documentId: "doc_1",
      body: "Updated truth.",
    });

    expect(result).toEqual({ ok: false, message: "You do not have access to that brain." });
    expect(updateGoatBrainDocumentForUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin brain mutations without writing", async () => {
    vi.mocked(currentGoatBrainByRef).mockResolvedValueOnce({
      context: { role: "member", user: { workosUserId: "user_1" } },
      brain: { id: "goat_brain_team" },
    } as Awaited<ReturnType<typeof currentGoatBrainByRef>>);

    const result = await updateGoatBrainDocumentAction({
      brainRef: "goat_brain_team",
      documentId: "doc_1",
      body: "Updated truth.",
    });

    expect(result).toEqual({ ok: false, message: "Only workspace admins can edit the brain." });
    expect(updateGoatBrainDocumentForUser).not.toHaveBeenCalled();
  });
});
