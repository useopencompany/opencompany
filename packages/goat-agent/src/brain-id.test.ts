import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listGoatBrainFiles: vi.fn(),
}));

vi.mock("@opencompany/db/goat-brain-files", () => ({
  listGoatBrainFiles: mocks.listGoatBrainFiles,
}));

import { nextAvailableGoatBrainId } from "./brain-id";

describe("nextAvailableGoatBrainId", () => {
  beforeEach(() => {
    mocks.listGoatBrainFiles.mockReset();
  });

  it("returns the requested id when it is available", async () => {
    mocks.listGoatBrainFiles.mockResolvedValue([]);

    await expect(nextAvailableGoatBrainId("main", "project-notes")).resolves.toBe("project-notes");
  });

  it("allocates the first unused numeric suffix", async () => {
    mocks.listGoatBrainFiles.mockResolvedValue([
      { brainId: "project-notes" },
      { brainId: "project-notes-2" },
    ]);

    await expect(nextAvailableGoatBrainId("main", "project-notes")).resolves.toBe(
      "project-notes-3",
    );
  });

  it("uses a valid fallback for an invalid requested id", async () => {
    mocks.listGoatBrainFiles.mockResolvedValue([]);

    await expect(nextAvailableGoatBrainId("main", "Not a brain id")).resolves.toBe("untitled");
  });
});
