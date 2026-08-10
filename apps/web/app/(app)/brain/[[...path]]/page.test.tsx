import { expect, it, vi } from "vitest";
import GoatBrainPage from "./page";

const routeMock = vi.hoisted(() => vi.fn(() => null));
const currentGoatUserMock = vi.hoisted(() => vi.fn());
const listGoatBrainForBrainMock = vi.hoisted(() => vi.fn());
const getGoatBrainOverviewStatsMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/GoatRoutes", () => ({
  GoatBrainRoute: routeMock,
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: currentGoatUserMock,
}));

vi.mock("@/lib/brain", () => ({
  listGoatBrainForBrain: listGoatBrainForBrainMock,
}));

vi.mock("@/lib/brain-overview", () => ({
  getGoatBrainOverviewStats: getGoatBrainOverviewStatsMock,
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
  currentGoatUserMock.mockResolvedValue({ brains: [brain], activeBrain: brain });
  getGoatBrainOverviewStatsMock.mockResolvedValue(stats);

  const page = await GoatBrainPage({
    params: Promise.resolve({ path: ["goat_brain_1"] }),
  });

  expect(listGoatBrainForBrainMock).not.toHaveBeenCalled();
  expect(getGoatBrainOverviewStatsMock).toHaveBeenCalledWith("goat_brain_1");
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
  currentGoatUserMock.mockResolvedValue({ brains: [brain], activeBrain: brain });
  listGoatBrainForBrainMock.mockResolvedValue(snapshot);
  getGoatBrainOverviewStatsMock.mockResolvedValue(stats);

  const page = await GoatBrainPage({
    params: Promise.resolve({ path: ["goat_brain_1", "people", "ada-lovelace"] }),
  });

  expect(listGoatBrainForBrainMock).toHaveBeenCalledWith("goat_brain_1");
  expect(getGoatBrainOverviewStatsMock).toHaveBeenCalledWith("goat_brain_1");
  expect(page.props).toMatchObject({
    path: ["people", "ada-lovelace"],
    routeBrainId: "goat_brain_1",
    initialBrainSnapshot: snapshot,
    initialOverviewStats: stats,
  });
});
