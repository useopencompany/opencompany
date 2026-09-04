import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WikiIngestActivityFeed } from "./WikiIngestActivityFeed";

const mocks = vi.hoisted(() => ({
  listWikiIngestActivity: vi.fn(),
}));

vi.mock("@/lib/wiki-source-api", () => ({
  listWikiIngestActivity: mocks.listWikiIngestActivity,
}));

describe("WikiIngestActivityFeed", () => {
  beforeEach(() => {
    mocks.listWikiIngestActivity.mockReset();
  });

  it("shows a loading state and then the empty state", async () => {
    let resolvePage: ((value: { items: never[]; nextCursor: null }) => void) | undefined;
    mocks.listWikiIngestActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    render(<WikiIngestActivityFeed />);

    expect(screen.getByLabelText("Loading Wiki ingestion activity")).toBeInTheDocument();
    resolvePage?.({ items: [], nextCursor: null });
    expect(await screen.findByText("No ingestion activity yet")).toBeInTheDocument();
  });

  it("renders every outcome, skip/failure reasons, and succeeded page links", async () => {
    mocks.listWikiIngestActivity.mockResolvedValueOnce({
      items: [
        activity({
          id: "succeeded",
          outcome: "succeeded",
          pages: [{ path: "projects/launch-plan", title: "Launch plan", action: "updated" }],
        }),
        activity({ id: "skipped", outcome: "skipped", reason: "Routine status chatter" }),
        activity({ id: "failed", outcome: "failed", reason: "Gateway unavailable" }),
        activity({ id: "running", outcome: "running" }),
        activity({ id: "queued", outcome: "queued" }),
      ],
      nextCursor: null,
    });

    render(<WikiIngestActivityFeed />);

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    for (const outcome of ["Skipped", "Failed", "Running", "Queued"]) {
      expect(screen.getByText(outcome)).toBeInTheDocument();
    }
    expect(screen.getByText("Routine status chatter")).toBeInTheDocument();
    expect(screen.getByText("Gateway unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Launch plan" })).toHaveAttribute(
      "href",
      "/wiki/projects/launch-plan",
    );
  });

  it("shows a recoverable initial error", async () => {
    mocks.listWikiIngestActivity
      .mockRejectedValueOnce(new Error("API unavailable"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const user = userEvent.setup();
    render(<WikiIngestActivityFeed />);

    expect(await screen.findByText("Activity didn't load")).toBeInTheDocument();
    expect(screen.getByText("API unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No ingestion activity yet")).toBeInTheDocument();
  });

  it("paginates without duplicating activity rows", async () => {
    mocks.listWikiIngestActivity
      .mockResolvedValueOnce({
        items: [activity({ id: "job_1", title: "First window" })],
        nextCursor: "cursor_2",
      })
      .mockResolvedValueOnce({
        items: [
          activity({ id: "job_1", title: "First window" }),
          activity({ id: "job_2", title: "Second window" }),
        ],
        nextCursor: null,
      });
    const user = userEvent.setup();
    render(<WikiIngestActivityFeed />);

    await user.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(mocks.listWikiIngestActivity).toHaveBeenLastCalledWith({
        limit: 20,
        cursor: "cursor_2",
      }),
    );
    expect(screen.getAllByText("First window")).toHaveLength(1);
    expect(screen.getByText("Second window")).toBeInTheDocument();
  });
});

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    provider: "gmail",
    sourceType: "thread",
    title: "Launch update",
    outcome: "succeeded",
    reason: null,
    pages: [],
    attempts: 1,
    occurredAt: "2026-08-24T08:00:00.000Z",
    completedAt: "2026-08-24T09:01:00.000Z",
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:01:00.000Z",
    ...overrides,
  };
}
