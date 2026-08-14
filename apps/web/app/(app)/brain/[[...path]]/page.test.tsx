import { expect, it, vi } from "vitest";
import GoatBrainPage from "./page";

const routeMock = vi.hoisted(() => vi.fn(() => null));
const currentGoatUserMock = vi.hoisted(() => vi.fn());
const getHeadlessBrainSnapshotMock = vi.hoisted(() => vi.fn());
const getHeadlessBrainOverviewMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/GoatRoutes", () => ({
  GoatBrainRoute: routeMock,
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: currentGoatUserMock,
}));

vi.mock("@/lib/headless-knowledge-server", () => ({
  getHeadlessBrainSnapshot: getHeadlessBrainSnapshotMock,
  getHeadlessBrainOverview: getHeadlessBrainOverviewMock,
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
  getHeadlessBrainOverviewMock.mockResolvedValue(stats);

  const page = await GoatBrainPage({
    params: Promise.resolve({ path: ["goat_brain_1"] }),
  });

  expect(getHeadlessBrainSnapshotMock).not.toHaveBeenCalled();
  expect(getHeadlessBrainOverviewMock).toHaveBeenCalledWith("goat_brain_1");
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
  getHeadlessBrainSnapshotMock.mockResolvedValue(snapshot);
  getHeadlessBrainOverviewMock.mockResolvedValue(stats);

  const page = await GoatBrainPage({
    params: Promise.resolve({ path: ["goat_brain_1", "people", "ada-lovelace"] }),
  });

  expect(getHeadlessBrainSnapshotMock).toHaveBeenCalledWith("goat_brain_1");
  expect(getHeadlessBrainOverviewMock).toHaveBeenCalledWith("goat_brain_1");
  expect(page.props).toMatchObject({
    path: ["people", "ada-lovelace"],
    routeBrainId: "goat_brain_1",
    initialBrainSnapshot: snapshot,
    initialOverviewStats: stats,
  });
});
