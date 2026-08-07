import { expect, it, vi } from "vitest";
import BrainPage from "./page";

const routeMock = vi.hoisted(() => vi.fn(() => null));
const currentUserMock = vi.hoisted(() => vi.fn());
const listBrainForBrainMock = vi.hoisted(() => vi.fn());
const getBrainOverviewStatsMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/AppRoutes", () => ({
  BrainRoute: routeMock,
}));

vi.mock("@/lib/auth", () => ({
  currentUser: currentUserMock,
}));

vi.mock("@/lib/brain", () => ({
  listBrainForBrain: listBrainForBrainMock,
}));

vi.mock("@/lib/brain-overview", () => ({
  getBrainOverviewStats: getBrainOverviewStatsMock,
}));

const brain = {
  id: "goat_brain_1",
  name: "General",
  slug: "general",
  description: null,
  visibility: "workspace" as const,
};

it("loads only aggregate stats for the Brain overview", async () => {
  const stats = {
    windowStartedAt: "2026-07-21T10:00:00.000Z",
    itemsAddedLast7Days: 11,
    retrievalsLast7Days: 7,
    activeSources: 3,
  };
  currentUserMock.mockResolvedValue({ brains: [brain], activeBrain: brain });
  getBrainOverviewStatsMock.mockResolvedValue(stats);

  const page = await BrainPage({
    params: Promise.resolve({ path: ["goat_brain_1"] }),
  });

  expect(listBrainForBrainMock).not.toHaveBeenCalled();
  expect(getBrainOverviewStatsMock).toHaveBeenCalledWith("goat_brain_1");
  expect(page.props).toMatchObject({
    path: [],
    routeBrainId: "goat_brain_1",
    initialBrainSnapshot: null,
    initialOverviewStats: stats,
  });
});

it("loads the document snapshot and aggregate stats for local Overview navigation from a file", async () => {
  const snapshot = { folders: [], documents: [] };
  const stats = {
    windowStartedAt: "2026-07-21T10:00:00.000Z",
    itemsAddedLast7Days: 11,
    retrievalsLast7Days: 7,
    activeSources: 3,
  };
  currentUserMock.mockResolvedValue({ brains: [brain], activeBrain: brain });
  listBrainForBrainMock.mockResolvedValue(snapshot);
  getBrainOverviewStatsMock.mockResolvedValue(stats);

  const page = await BrainPage({
    params: Promise.resolve({ path: ["goat_brain_1", "people", "ada-lovelace"] }),
  });

  expect(listBrainForBrainMock).toHaveBeenCalledWith("goat_brain_1");
  expect(getBrainOverviewStatsMock).toHaveBeenCalledWith("goat_brain_1");
  expect(page.props).toMatchObject({
    path: ["people", "ada-lovelace"],
    routeBrainId: "goat_brain_1",
    initialBrainSnapshot: snapshot,
    initialOverviewStats: stats,
  });
});
