import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { BrainOverview } from "./BrainOverview";

vi.mock("@/components/BrainActivity", () => ({
  BrainRecentActivity: ({ brainRef, filter }: { brainRef: string; filter: string }) => (
    <div data-testid="recent-activity">
      {brainRef}:{filter}
    </div>
  ),
}));

it("shows useful activity by default and lets the user change the activity filter", async () => {
  const user = userEvent.setup();
  render(
    <BrainOverview
      brainName="Company brain"
      brainRef="goat_brain_1"
      stats={{
        windowStartedAt: "2026-07-08T09:00:00.000Z",
        itemsAddedLast7Days: 1,
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
  expect(screen.getByRole("combobox", { name: "Filter recent activity" })).toHaveTextContent(
    "Filed",
  );
  expect(screen.getByTestId("recent-activity")).toHaveTextContent("goat_brain_1:filed");

  await user.click(screen.getByRole("combobox", { name: "Filter recent activity" }));
  await user.click(screen.getByRole("option", { name: "Skipped" }));

  expect(screen.getByRole("combobox", { name: "Filter recent activity" })).toHaveTextContent(
    "Skipped",
  );
  expect(screen.getByTestId("recent-activity")).toHaveTextContent("goat_brain_1:skipped");
});
