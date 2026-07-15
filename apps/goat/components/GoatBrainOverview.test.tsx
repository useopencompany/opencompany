import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { GoatBrainDocumentView } from "@/lib/brain";
import { GoatBrainOverview } from "./GoatBrainOverview";

vi.mock("@/components/GoatBrainActivity", () => ({
  GoatBrainRecentActivity: ({ brainRef }: { brainRef: string }) => (
    <div data-testid="recent-activity">{brainRef}</div>
  ),
}));

it("shows 7-day growth, retrievals, sources, and recent activity", () => {
  render(
    <GoatBrainOverview
      brainName="Company brain"
      brainRef="goat_brain_1"
      documents={[
        createDocument({ id: "recent", createdAt: "2026-07-14T09:00:00.000Z" }),
        createDocument({ id: "old", createdAt: "2026-07-01T09:00:00.000Z" }),
      ]}
      stats={{
        windowStartedAt: "2026-07-08T09:00:00.000Z",
        retrievalsLast7Days: 42,
        activeSources: 3,
      }}
    />,
  );

  expect(screen.getByRole("heading", { name: "Company brain" })).toBeInTheDocument();
  expect(screen.getByText("Items added")).toBeInTheDocument();
  expect(screen.getByText("1")).toBeInTheDocument();
  expect(screen.getByText("Retrievals")).toBeInTheDocument();
  expect(screen.getByText("42")).toBeInTheDocument();
  expect(screen.getByText("Active sources")).toBeInTheDocument();
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByTestId("recent-activity")).toHaveTextContent("goat_brain_1");
});

function createDocument({
  id,
  createdAt,
}: {
  id: string;
  createdAt: string;
}): GoatBrainDocumentView {
  return {
    id,
    brainId: id,
    folderPath: "inbox",
    path: `inbox/${id}.md`,
    title: id,
    content: "",
    body: "",
    timeline: [],
    format: "markdown",
    mimeType: "text/markdown",
    relations: [],
    sources: [],
    kind: "page",
    type: "note",
    status: "draft",
    aliases: [],
    contentHash: id,
    sizeBytes: 0,
    createdAt,
    updatedAt: createdAt,
  };
}
